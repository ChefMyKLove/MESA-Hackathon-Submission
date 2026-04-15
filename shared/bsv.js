/**
 * shared/bsv.js — Real BSV transaction builder for MESA agents.
 *
 * Handles:
 *  - UTXO fetching from WhatsOnChain (one-time at startup)
 *  - Transaction building with P2PKH + OP_RETURN — ZERO WoC calls after startup
 *  - Broadcasting via WhatsOnChain with GorillaPool ARC fallback
 *  - Local UTXO pool to avoid double-spends
 *
 * Key design: after refreshUtxos() at startup, send() never touches WoC again.
 * The @bsv/sdk P2PKH.unlock() accepts sourceSatoshis + lockingScript directly,
 * and calculateChange() only needs a minimal stub — both values are in our local pool.
 */
import { PrivateKey, PublicKey, P2PKH, Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk'

const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const FEE_RATE_SAT_PER_KB = 500  // 0.5 sat/byte — confirmed working on BSV mainnet

// ── BsvWallet ────────────────────────────────────────────────────────────────

export class BsvWallet {
  constructor(privateKeyHex) {
    this.privKey  = PrivateKey.fromHex(privateKeyHex)
    this.pubKey   = this.privKey.toPublicKey()
    this.address  = this.pubKey.toAddress('mainnet').toString()
    this._utxos      = []          // local pool: { txid, vout, satoshis, script }
    this._locked     = new Set()   // keys currently being spent (prevent double-spend)
    this._myScript   = null        // cached P2PKH locking script object
    this._recentTxHex = new Map()  // txid → hex for unconfirmed txs we built (chain support)
    this._chainBroken = false      // debounce flag for UTXO recovery after broadcast failure
  }

  get address_str() { return this.address }

  // Fetch UTXOs from WhatsOnChain. After the initial load, trust the local pool —
  // send() removes spent UTXOs and adds change outputs, so it stays accurate.
  async refreshUtxos(force = false) {
    if (!force && this._utxos.length > 0) return

    let raw
    for (let attempt = 0; attempt < 5; attempt++) {
      const resp = await fetch(`${WOC_BASE}/address/${this.address}/unspent`)
      if (resp.ok) { raw = await resp.json(); break }
      if (resp.status === 429) { await sleep(1000 * (attempt + 1)); continue }
      throw new Error(`WoC UTXO fetch failed: ${resp.status}`)
    }
    if (!raw) throw new Error('WoC UTXO fetch failed after 5 retries')

    // P2PKH locking script is deterministic from our address — derive once.
    this._myScript = new P2PKH().lock(this.address)
    const myScriptHex = this._myScript.toHex()

    this._utxos = raw.map(u => ({
      txid:     u.tx_hash,
      vout:     u.tx_pos,
      satoshis: u.value,
      script:   myScriptHex,
    }))
  }

  // No-op — kept for compatibility. WoC source tx pre-fetching is no longer needed
  // because send() builds inputs using local satoshis + lockingScript directly.
  async warmCache() {}

  // Pick UTXOs to cover target amount + estimated fee, mark as locked
  _selectUtxos(targetSats) {
    const available = this._utxos.filter(u => !this._locked.has(u.txid + ':' + u.vout))
    available.sort((a, b) => b.satoshis - a.satoshis)  // largest first

    const selected = []
    let total = 0
    for (const u of available) {
      selected.push(u)
      total += u.satoshis
      if (total >= targetSats + 500) break  // 500 sat buffer for fee
    }

    if (total < targetSats + 100) {
      throw new Error(`Insufficient funds: have ${total} sats, need ${targetSats + 100}`)
    }

    for (const u of selected) this._locked.add(u.txid + ':' + u.vout)
    return { selected, total }
  }

  _unlock(utxos) {
    for (const u of utxos) this._locked.delete(u.txid + ':' + u.vout)
  }

  /**
   * Build, sign, and broadcast a transaction — zero WoC calls.
   *
   * Uses @bsv/sdk's P2PKH.unlock(key, 'all', false, sourceSatoshis, lockingScript)
   * which signs without needing the full source transaction. A minimal stub object
   * satisfies calculateChange()'s sourceTransaction.outputs[vout].satoshis check.
   *
   * @param {Array} outputs - [{ address, satoshis }, ...] — regular P2PKH outputs
   * @param {string|null} opReturn - ASCII string for OP_RETURN (null to omit)
   * @returns {string} txid
   */
  async send(outputs, opReturn = null) {
    await this.refreshUtxos()

    const myScript = this._myScript ?? new P2PKH().lock(this.address)
    const totalOut = outputs.reduce((s, o) => s + o.satoshis, 0)
    const { selected, total } = this._selectUtxos(totalOut)

    try {
      const tx = new Transaction()

      for (const u of selected) {
        // Minimal stub: satisfies calculateChange()'s sourceTransaction.outputs[vout].satoshis
        const srcStub = { outputs: [] }
        srcStub.outputs[u.vout] = { satoshis: u.satoshis }

        tx.addInput({
          sourceTXID:          u.txid,
          sourceOutputIndex:   u.vout,
          sequence:            0xffffffff,
          sourceTransaction:   srcStub,
          // Pass satoshis + lockingScript directly — no source tx WoC fetch needed
          unlockingScriptTemplate: new P2PKH().unlock(
            this.privKey, 'all', false, u.satoshis, myScript
          ),
        })
      }

      // P2PKH outputs
      for (const out of outputs) {
        tx.addOutput({
          lockingScript: new P2PKH().lock(out.address),
          satoshis: out.satoshis,
        })
      }

      // OP_RETURN data output — built from raw hex to avoid @bsv/sdk chunk encoding quirks.
      // OP_FALSE (00) + OP_RETURN (6a) + length byte + UTF-8 data.
      // Data ≤75 bytes: single byte length. Data 76–255 bytes: OP_PUSHDATA1 (4c) + length byte.
      if (opReturn) {
        const dataBytes = Buffer.from(opReturn, 'utf8')
        const len = dataBytes.length
        const lenHex = len <= 75
          ? len.toString(16).padStart(2, '0')
          : '4c' + len.toString(16).padStart(2, '0')
        const scriptHex = '006a' + lenHex + dataBytes.toString('hex')
        tx.addOutput({
          lockingScript: Script.fromHex(scriptHex),
          satoshis: 0,
        })
      }

      // Change output — record its index BEFORE adding so we can find it precisely later.
      // Never rely on position assumptions (e.g. "last output") — OP_RETURN may or may not exist.
      const changeIndex = tx.outputs.length
      tx.addOutput({
        lockingScript: new P2PKH().lock(this.address),
        change: true,
      })

      await tx.fee(new SatoshisPerKilobyte(FEE_RATE_SAT_PER_KB))
      await tx.sign()

      // Compute txid from the signed tx — deterministic, no network needed.
      const txid = tx.id('hex')

      // Store raw hex in our recent-tx buffer so _broadcast() can submit the
      // full chain to ARC's bulk endpoint when this tx's output is spent next.
      this._recentTxHex.set(txid, tx.toHex())
      if (this._recentTxHex.size > 100) {
        // Prune oldest entry to cap memory usage
        this._recentTxHex.delete(this._recentTxHex.keys().next().value)
      }

      // Update local UTXO pool BEFORE broadcasting.
      // This is the key to high throughput: the next send() sees the change output
      // immediately and can chain from it without waiting 1-3s for the broadcast.
      // BSV's ARC handles chained mempool transactions natively.
      this._utxos = this._utxos.filter(u =>
        !selected.some(s => s.txid === u.txid && s.vout === u.vout)
      )
      const changeOut = tx.outputs[changeIndex]
      if (changeOut && changeOut.satoshis > 0) {
        this._utxos.push({
          txid,
          vout:     tx.outputs.length - 1,
          satoshis: changeOut.satoshis,
          script:   myScript.toHex(),
        })
      }
      // Release the UTXO lock immediately — spent locally, no longer needed.
      this._unlock(selected)

      // Fire-and-forget broadcast. Don't await — return txid immediately so the
      // caller's queue can process the next payment without waiting for the network.
      // On failure: log the error and schedule a UTXO pool reset from WhatsOnChain.
      // The reset wipes phantom change UTXOs from the broken chain so subsequent
      // sends use real confirmed UTXOs again. Debounced to avoid hammering WoC.
      this._broadcast(tx).catch(err => {
        // Use process.stderr.write to ensure visibility even when stdout is redirected
        process.stderr.write(`\n[BROADCAST FAIL] txid=${txid.slice(0, 16)} err=${err.message}\n`)
        console.error(`[wallet] broadcast failed ${txid.slice(0, 12)}: ${err.message}`)
        if (!this._chainBroken) {
          this._chainBroken = true
          setTimeout(async () => {
            try {
              await this.refreshUtxos(true)
              console.error(`[wallet] UTXO pool reset after chain break — ${this._utxos.length} UTXOs restored`)
            } catch (e) {
              console.error(`[wallet] UTXO reset failed: ${e.message}`)
            } finally {
              this._chainBroken = false
            }
          }, 2000)  // 2s debounce — collect all failures before hitting WoC once
        }
      })

      return txid

    } catch (err) {
      this._unlock(selected)
      throw err
    }
  }

  async _broadcast(tx) {
    const hex  = tx.toHex()
    const txid = tx.id('hex')

    // Build the ancestor chain for ARC's bulk endpoint.
    // ARC processes an array of txs in order — submitting [parent, child] together
    // guarantees the parent is in ARC's mempool before the child is validated.
    const chain = []
    for (const input of tx.inputs) {
      const parentTxid = input.sourceTXID
      if (parentTxid && this._recentTxHex.has(parentTxid)) {
        chain.push({ rawTx: this._recentTxHex.get(parentTxid) })
      }
    }
    chain.push({ rawTx: hex })

    // Submit to ARC (GorillaPool) AND WoC simultaneously.
    // ARC alone is not enough — TAAL mines most BSV blocks and they pull from
    // WoC-connected nodes. Parallel submission ensures both mining pools see
    // every tx immediately. We consider broadcast successful if EITHER accepts.
    const arcPromise = (async () => {
      try {
        // Use bulk endpoint for chains, single for standalone txs
        if (chain.length > 1) {
          const resp = await fetch('https://arc.gorillapool.io/v1/txs', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(chain),
          })
          const body = await resp.text()
          if (resp.ok) return true
          if (body.includes('already') || body.includes('txn-already-in-mempool')) return true
        }
        // Single-tx endpoint (first tx in chain or bulk fallback)
        const resp = await fetch('https://arc.gorillapool.io/v1/tx', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ rawTx: hex }),
        })
        const body = await resp.text()
        if (resp.ok) return true
        if (body.includes('already') || body.includes('txn-already-in-mempool')) return true
        return false
      } catch {
        return false
      }
    })()

    const wocPromise = (async () => {
      try {
        const resp = await fetch(`${WOC_BASE}/tx/raw`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ txhex: hex }),
        })
        const body = await resp.text()
        if (resp.ok) return true
        if (body.includes('already') || body.includes('txn-already-in-mempool')) return true
        // WoC 429 — back off and retry once
        if (resp.status === 429) {
          await sleep(1000)
          const r2 = await fetch(`${WOC_BASE}/tx/raw`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ txhex: hex }),
          })
          return r2.ok
        }
        return false
      } catch {
        return false
      }
    })()

    const [arcOk, wocOk] = await Promise.all([arcPromise, wocPromise])

    if (arcOk || wocOk) return txid

    throw new Error(`Broadcast failed on all endpoints (arc=${arcOk} woc=${wocOk})`)
  }

  balance() {
    return this._utxos
      .filter(u => !this._locked.has(u.txid + ':' + u.vout))
      .reduce((s, u) => s + u.satoshis, 0)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Address derivation ───────────────────────────────────────────────────────

export function addressFromPrivKey(hexKey) {
  if (!hexKey) throw new Error('addressFromPrivKey: key is required')

  if (hexKey.length === 66 && (hexKey.startsWith('02') || hexKey.startsWith('03'))) {
    const pub = PublicKey.fromString(hexKey)
    return pub.toAddress('mainnet').toString()
  }

  const priv = PrivateKey.fromHex(hexKey)
  return priv.toPublicKey().toAddress('mainnet').toString()
}
