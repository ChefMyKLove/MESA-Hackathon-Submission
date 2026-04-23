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
const FEE_RATE_SAT_PER_KB = 200  // 0.2 sat/byte — reliable next-block confirmation on BSV mainnet

// Max unconfirmed ancestors before we must wait for a block.
// BSV standard mempool policy is 25; we use 20 as a safety margin.
const MAX_CHAIN_DEPTH = 20

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

    // On forced refresh (chain recovery), filter out UTXOs we've already locally spent.
    // WoC /unspent only shows confirmed outputs — unconfirmed spending txs aren't
    // reflected. Without this filter, deep unconfirmed chains cause every subsequent
    // send() to fail with txn-mempool-conflict since WoC returns the original confirmed
    // input that our mempool chain already consumed.
    const spentByUs = force ? this._recentlySpentOutpoints() : new Set()

    this._utxos = raw
      .filter(u => !spentByUs.has(u.tx_hash + ':' + u.tx_pos))
      .map(u => ({
        txid:     u.tx_hash,
        vout:     u.tx_pos,
        satoshis: u.value,
        script:   myScriptHex,
        depth:    0,   // confirmed on-chain — chain depth resets to 0
      }))
  }

  // Parse input outpoints from all transactions in _recentTxHex.
  // Returns a Set of "txid:vout" strings for UTXOs we've already spent locally.
  _recentlySpentOutpoints() {
    const spent = new Set()
    for (const hex of this._recentTxHex.values()) {
      try {
        const buf = Buffer.from(hex, 'hex')
        let off = 4  // skip version (4 bytes)
        const nIn = buf[off++]
        if (nIn > 0xfc) continue  // skip multibyte varint (rare, not our txs)
        for (let i = 0; i < nIn; i++) {
          const txid = Buffer.from(buf.slice(off, off + 32)).reverse().toString('hex')
          const vout = buf.readUInt32LE(off + 32)
          spent.add(`${txid}:${vout}`)
          off += 36
          const scriptLen = buf[off++]
          if (scriptLen > 0xfc) break  // skip multibyte varint
          off += scriptLen + 4  // script bytes + sequence (4 bytes)
        }
      } catch { /* skip malformed */ }
    }
    return spent
  }

  // Merge large confirmed UTXOs from GorillaPool into the local pool.
  // GorillaPool has no 1000-UTXO cap, so this recovers wallets with the dust
  // UTXO problem where WoC's /unspent hides the real funded output behind 1000 dust entries.
  async _mergeGorillaPoolUtxos() {
    try {
      const r = await fetch(
        `https://v3.ordinals.gorillapool.io/utxos/${this.address}?bsv20=false`
      )
      if (!r.ok) return
      const data = await r.json()
      const rows = Array.isArray(data) ? data : (data?.utxos ?? data?.data ?? [])
      const myScript = this._myScript ?? new P2PKH().lock(this.address)
      const spentByUs = this._recentlySpentOutpoints()
      const existingKeys = new Set(this._utxos.map(u => u.txid + ':' + u.vout))
      const added = rows
        .filter(u => {
          const sats = u.satoshis ?? u.value ?? 0
          const key  = `${u.txid ?? u.tx_hash}:${u.vout ?? u.tx_pos ?? 0}`
          return sats >= 100_000 && !existingKeys.has(key) && !spentByUs.has(key)
        })
        .map(u => ({
          txid:     u.txid ?? u.tx_hash,
          vout:     u.vout ?? u.tx_pos ?? 0,
          satoshis: u.satoshis ?? u.value,
          script:   myScript.toHex(),
          depth:    0,   // confirmed on-chain
        }))
      if (added.length > 0) {
        this._utxos.push(...added)
        console.error(`[wallet] GorillaPool recovery: +${added.length} UTXOs added`)
      }
    } catch { /* best-effort */ }
  }

  // No-op — kept for compatibility. WoC source tx pre-fetching is no longer needed
  // because send() builds inputs using local satoshis + lockingScript directly.
  async warmCache() {}

  // Pick UTXOs to cover target amount + estimated fee, mark as locked.
  // Prefers shallow-chain UTXOs (depth < MAX_CHAIN_DEPTH) so we never build
  // unconfirmed chains longer than miners will accept.
  _selectUtxos(targetSats) {
    const available = this._utxos.filter(u => !this._locked.has(u.txid + ':' + u.vout))

    // Sort: shallow first, then largest — minimises chain depth while maximising coverage
    available.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || b.satoshis - a.satoshis)

    // If every available UTXO is already at the depth limit, the caller must wait
    // for a block before we can safely build another chained tx.
    const shallowest = available[0]?.depth ?? 0
    if (available.length > 0 && shallowest >= MAX_CHAIN_DEPTH) {
      throw new Error(`CHAIN_DEPTH_LIMIT: all UTXOs at depth ${shallowest} — refresh after next block`)
    }

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

      // Compute the chain depth of the change output.
      // Change chains from the deepest selected input — +1 per unconfirmed hop.
      const parentDepth = selected.reduce((max, u) => Math.max(max, u.depth ?? 0), 0)
      const changeDepth = parentDepth + 1

      // Update local UTXO pool BEFORE broadcasting so the next queue slot can
      // immediately chain from the change output — ARC handles unconfirmed chains.
      this._utxos = this._utxos.filter(u =>
        !selected.some(s => s.txid === u.txid && s.vout === u.vout)
      )
      const changeOut = tx.outputs[changeIndex]
      if (changeOut && changeOut.satoshis > 0) {
        this._utxos.push({
          txid,
          vout:     changeIndex,
          satoshis: changeOut.satoshis,
          script:   myScript.toHex(),
          depth:    changeDepth,
        })
      }
      this._unlock(selected)

      // Await broadcast — we must know the tx actually landed in ARC before
      // returning txid to the caller.  Without this, the caller fires relay events
      // and increments on-chain counters for txs that were never sent.
      // On failure: retry 2× with back-off, then reset UTXO pool from WoC so the
      // next send() starts from a clean confirmed state.
      try {
        await this._broadcast(tx)
      } catch (err) {
        // Mempool conflict: the inputs we selected are already spent in the mempool.
        // This happens after a restart when WoC's unspent index lags behind.
        // Don't retry the same tx — immediately drop the stale UTXOs and refresh.
        if (err.message === 'MEMPOOL_CONFLICT') {
          this._utxos = this._utxos.filter(u => !(u.txid === txid && u.vout === changeIndex))
          // Also purge the conflicting inputs so they aren't re-selected
          this._utxos = this._utxos.filter(u =>
            !selected.some(s => s.txid === u.txid && s.vout === u.vout)
          )
          if (!this._chainBroken) {
            this._chainBroken = true
            try {
              await this.refreshUtxos(true)
              console.error(`[wallet] UTXO pool refreshed after mempool-conflict — ${this._utxos.length} UTXOs`)
            } finally {
              this._chainBroken = false
            }
          }
          throw new Error('MEMPOOL_CONFLICT: inputs already spent — UTXOs refreshed')
        }
        process.stderr.write(`\n[BROADCAST FAIL] txid=${txid.slice(0, 16)} err=${err.message}\n`)
        // Retry twice with back-off
        let retried = false
        for (let i = 1; i <= 2; i++) {
          await sleep(i * 2000)
          try { await this._broadcast(tx); retried = true; break } catch { /* next */ }
        }
        if (!retried) {
          // Remove the change UTXO we optimistically added — tx didn't land
          this._utxos = this._utxos.filter(u => !(u.txid === txid && u.vout === changeIndex))
          if (!this._chainBroken) {
            this._chainBroken = true
            setTimeout(async () => {
              try {
                await this.refreshUtxos(true)
                console.error(`[wallet] UTXO pool reset after broadcast failure — ${this._utxos.length} UTXOs restored`)
              } catch (e) {
                console.error(`[wallet] UTXO reset failed: ${e.message}`)
              } finally {
                this._chainBroken = false
              }
            }, 2000)
          }
          throw new Error(`Broadcast failed (3 attempts): ${err.message}`)
        }
      }

      return txid

    } catch (err) {
      this._unlock(selected)

      // Mempool conflict — stale UTXOs were already spent. UTXOs already refreshed
      // in the inner handler; retry the send immediately with fresh selection.
      if (err.message.startsWith('MEMPOOL_CONFLICT')) {
        return this.send(outputs, opReturn)
      }

      // Chain depth limit hit — all our UTXOs are unconfirmed chains too deep for
      // miners to accept. Refresh from WoC to get confirmed UTXOs, then retry once.
      if (err.message.startsWith('CHAIN_DEPTH_LIMIT') && !this._chainBroken) {
        console.error(`[wallet] chain depth limit — waiting for confirmation then retrying`)
        this._chainBroken = true
        await sleep(15_000)  // give the mempool 15s to get a block
        try {
          await this.refreshUtxos(true)
          console.error(`[wallet] chain reset — ${this._utxos.length} confirmed UTXOs`)
        } finally {
          this._chainBroken = false
        }
        // Retry the send with fresh confirmed UTXOs
        return this.send(outputs, opReturn)
      }

      // Ran out of funds — pull in any large UTXOs GorillaPool can see that WoC hides
      if (err.message.startsWith('Insufficient funds') && !this._chainBroken) {
        this._chainBroken = true
        setTimeout(async () => {
          try {
            await this._mergeGorillaPoolUtxos()
            await this.refreshUtxos(true)
            console.error(`[wallet] UTXO pool refreshed after insufficient funds — ${this._utxos.length} UTXOs restored`)
          } catch (e) {
            console.error(`[wallet] UTXO refresh failed: ${e.message}`)
          } finally {
            this._chainBroken = false
          }
        }, 5000)
      }
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
    //
    // X-WaitFor: STORED — ARC blocks the response until the tx is stored in its
    // own mempool (not just received at the HTTP layer). This confirms the tx is
    // actually accepted, not just ACK'd by the load balancer.
    //
    // Every fetch gets a 30s timeout. Without this, a hung connection deadlocks
    // the wallet queue forever.
    const arcPromise = (async () => {
      try {
        // Use bulk endpoint for chains so ARC gets parent before child
        if (chain.length > 1) {
          const resp = await fetch('https://arc.gorillapool.io/v1/txs', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
            body:    JSON.stringify(chain),
            signal:  AbortSignal.timeout(30_000),
          })
          const body = await resp.text()
          if (resp.ok) return _arcBodyOk(body, txid)
          if (body.includes('already') || body.includes('txn-already-in-mempool')) return true
        }
        // Single-tx fallback
        const resp = await fetch('https://arc.gorillapool.io/v1/tx', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
          body:    JSON.stringify({ rawTx: hex }),
          signal:  AbortSignal.timeout(30_000),
        })
        const body = await resp.text()
        if (resp.ok) return _arcBodyOk(body, txid)
        if (body.includes('already') || body.includes('txn-already-in-mempool')) return true
        if (body.includes('mempool-conflict') || body.includes('txn-mempool-conflict')) throw new Error('MEMPOOL_CONFLICT')
        process.stderr.write(`[ARC] ${resp.status}: ${body.slice(0, 120)}\n`)
        return false
      } catch (e) {
        process.stderr.write(`[ARC] fetch error: ${e.message}\n`)
        return false
      }
    })()

    const wocPromise = (async () => {
      try {
        const resp = await fetch(`${WOC_BASE}/tx/raw`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ txhex: hex }),
          signal:  AbortSignal.timeout(30_000),
        })
        const body = await resp.text()
        if (resp.ok) return true
        if (body.includes('already') || body.includes('txn-already-in-mempool')) return true
        if (body.includes('mempool-conflict') || body.includes('txn-mempool-conflict')) throw new Error('MEMPOOL_CONFLICT')
        if (resp.status === 429) {
          await sleep(1500)
          const r2 = await fetch(`${WOC_BASE}/tx/raw`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ txhex: hex }),
            signal:  AbortSignal.timeout(30_000),
          })
          return r2.ok
        }
        process.stderr.write(`[WoC] ${resp.status}: ${body.slice(0, 120)}\n`)
        return false
      } catch (e) {
        process.stderr.write(`[WoC] fetch error: ${e.message}\n`)
        return false
      }
    })()

    let arcOk, wocOk
    try {
      ;[arcOk, wocOk] = await Promise.all([arcPromise, wocPromise])
    } catch (e) {
      if (e.message === 'MEMPOOL_CONFLICT') throw e
      throw e
    }

    if (arcOk || wocOk) return txid

    throw new Error(`Broadcast failed on all endpoints (arc=${arcOk} woc=${wocOk})`)
  }

  // Parse ARC JSON response and confirm our txid was accepted (not rejected).
  // ARC bulk endpoint returns an array; single endpoint returns an object.
  // Returns true if tx was stored/accepted, false if explicitly rejected.
  // Falls back to true on non-JSON responses so a schema change doesn't break us.

  // (defined as a free function below — see _arcBodyOk)
  balance() {
    return this._utxos
      .filter(u => !this._locked.has(u.txid + ':' + u.vout))
      .reduce((s, u) => s + u.satoshis, 0)
  }

  /**
   * Consolidate UTXOs if count exceeds threshold — called periodically by the orchestrator.
   * Merges all unlocked UTXOs into a single output back to self.
   * Fire-and-forget: updates local pool immediately, broadcasts in background.
   *
   * @param {number} threshold  - trigger when unlocked UTXO count exceeds this (default 200)
   * @param {number} maxInputs  - max inputs per consolidation tx to keep size manageable
   * @returns {string|null}     - txid if consolidation fired, null if not needed
   */
  async consolidateIfNeeded(threshold = 200, maxInputs = 400) {
    const available = this._utxos.filter(u => !this._locked.has(u.txid + ':' + u.vout))
    if (available.length <= threshold) return null

    // Take up to maxInputs (largest first so we preserve the most value per tx)
    // Only merge the EXCESS UTXOs — keep `threshold` in the pool so payments continue.
    const excess = available.length - threshold
    const toConsolidate = available.sort((a, b) => b.satoshis - a.satoshis).slice(0, Math.min(excess, maxInputs))
    const total = toConsolidate.reduce((s, u) => s + u.satoshis, 0)

    console.log(`[wallet] auto-consolidate: ${available.length} UTXOs → merging ${toConsolidate.length} (${total} sats)`)

    const myScript = this._myScript ?? new P2PKH().lock(this.address)

    // Lock all inputs for the duration of the build
    for (const u of toConsolidate) this._locked.add(u.txid + ':' + u.vout)

    try {
      const tx = new Transaction()

      for (const u of toConsolidate) {
        const srcStub = { outputs: [] }
        srcStub.outputs[u.vout] = { satoshis: u.satoshis }
        tx.addInput({
          sourceTXID:              u.txid,
          sourceOutputIndex:       u.vout,
          sequence:                0xffffffff,
          sourceTransaction:       srcStub,
          unlockingScriptTemplate: new P2PKH().unlock(
            this.privKey, 'all', false, u.satoshis, myScript
          ),
        })
      }

      tx.addOutput({ lockingScript: new P2PKH().lock(this.address), change: true })

      await tx.fee(new SatoshisPerKilobyte(FEE_RATE_SAT_PER_KB))
      await tx.sign()

      const txid    = tx.id('hex')
      const outSats = tx.outputs[0]?.satoshis ?? 0

      if (outSats <= 0) {
        // Fee exceeded total — dust is worthless, just drop it from pool
        this._utxos = this._utxos.filter(u =>
          !toConsolidate.some(c => c.txid === u.txid && c.vout === u.vout)
        )
        this._unlock(toConsolidate)
        console.log(`[wallet] auto-consolidate: dust worthless after fee — dropped ${toConsolidate.length} UTXOs`)
        return null
      }

      // Update local pool before broadcast (same pattern as send())
      this._utxos = this._utxos.filter(u =>
        !toConsolidate.some(c => c.txid === u.txid && c.vout === u.vout)
      )
      this._utxos.push({ txid, vout: 0, satoshis: outSats, script: myScript.toHex(), depth: 1 })
      this._unlock(toConsolidate)

      this._recentTxHex.set(txid, tx.toHex())
      if (this._recentTxHex.size > 100) {
        this._recentTxHex.delete(this._recentTxHex.keys().next().value)
      }

      const remaining = this._utxos.filter(u => !this._locked.has(u.txid + ':' + u.vout)).length
      console.log(`[wallet] auto-consolidate complete: ${txid.slice(0, 16)}…  ${outSats} sats  (${remaining} UTXOs remaining)`)

      this._broadcast(tx).catch(err => {
        console.error(`[wallet] consolidation broadcast failed: ${err.message}`)
        if (!this._chainBroken) {
          this._chainBroken = true
          setTimeout(async () => {
            try { await this.refreshUtxos(true) }
            catch (e) { console.error(`[wallet] UTXO reset failed: ${e.message}`) }
            finally   { this._chainBroken = false }
          }, 2000)
        }
      })

      return txid

    } catch (err) {
      this._unlock(toConsolidate)
      console.error(`[wallet] auto-consolidate failed: ${err.message}`)
      return null
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// Parse ARC's JSON response and check our txid was actually stored.
// ARC bulk endpoint → array; single endpoint → object.
// If txStatus is REJECTED or ERROR we return false so the caller retries.
// Unknown shapes fall back to true (trust HTTP 200).
function _arcBodyOk(body, txid) {
  try {
    const json = JSON.parse(body)
    const items = Array.isArray(json) ? json : [json]
    // Find entry matching our txid (bulk may include parent entries)
    const entry = items.find(i => i.txid === txid) ?? items[items.length - 1]
    if (!entry) return true  // no matching entry — trust HTTP 200
    const status = entry.txStatus ?? entry.status ?? ''
    if (status === 'REJECTED' || status === 'ERROR') {
      process.stderr.write(`[ARC] txStatus=${status} extraInfo=${entry.extraInfo ?? ''}\n`)
      return false
    }
    return true
  } catch {
    return true  // non-JSON — trust HTTP 200
  }
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
