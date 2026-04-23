/**
 * scripts/fund-from-old-orch.js
 *
 * Funds all 11 new agent wallets from the gen1 old orchestrator
 * (18xNrXZhS1jBVwPb9E3mUvLrLqnT29EGt9) which has 285k+ dust UTXOs that
 * fool the normal WoC /unspent endpoint.
 *
 * Uses GorillaPool paginated fetch to load ALL UTXOs, groups them into
 * batches of 400, sweeps each batch proportionally to the 11 target
 * wallets, then broadcasts via ARC.
 *
 * Usage:
 *   node scripts/fund-from-old-orch.js
 *
 * The source key is hardcoded (gen1 old orchestrator).
 * Target addresses are read from the current .env files.
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync } from 'fs'

const OLD_KEY  = '9b080c6221282881e08d631fe9c225360b32db6dadc0f917ecf760f39a15b746'
const FEE_RATE = 500       // sat/KB
const BATCH    = 400       // inputs per tx — stays well under any tx-size limit
const MIN_BATCH_SATS = 50_000  // skip batches worth less than fees

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC_BULK = 'https://arc.gorillapool.io/v1/txs'
const ARC_ONE  = 'https://arc.gorillapool.io/v1/tx'
const BSV_PRICE = 40

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Source wallet setup ───────────────────────────────────────────────────────

const priv     = PrivateKey.fromHex(OLD_KEY)
const address  = priv.toPublicKey().toAddress('mainnet').toString()
const myScript = new P2PKH().lock(address)

// ── Target wallets (read from .env files) ─────────────────────────────────────

const BUFFER = 1.15
const ENV_FILES = [
  { file: '.env.orchestrator', label: 'NEXUS (orch)', targetSats: Math.ceil(22_300_000 * BUFFER) },
  { file: '.env.labeler1',     label: 'ARIA  (L1)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler2',     label: 'BOLT  (L2)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler3',     label: 'CIPHER(L3)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler4',     label: 'DELTA (L4)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler5',     label: 'ECHO  (L5)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler6',     label: 'FLUX  (L6)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler7',     label: 'GRAPH (L7)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler8',     label: 'HELIX (L8)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler9',     label: 'IRIS  (L9)',   targetSats: Math.ceil(24_500_000 * BUFFER) },
  { file: '.env.labeler10',    label: 'JADE  (L10)',  targetSats: Math.ceil(24_500_000 * BUFFER) },
]

function loadAddress(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) {
        const hex = t.slice('AGENT_KEY='.length).trim()
        if (hex.length === 64) return PrivateKey.fromHex(hex).toPublicKey().toAddress('mainnet').toString()
      }
    }
  } catch {}
  return null
}

// ── GorillaPool paginated UTXO fetch ─────────────────────────────────────────

async function fetchAllUtxos() {
  const seen = new Set()
  const all  = []

  // ── 1. GorillaPool paginated (no cap, but sometimes down) ────────────────
  let gpOk = false
  const LIMIT = 1000
  let offset  = 0
  let pages   = 0
  process.stdout.write('  Trying GorillaPool paginated...')
  try {
    while (pages < 300) {
      const r = await fetch(
        `https://v3.ordinals.gorillapool.io/utxos/${address}?bsv20=false&limit=${LIMIT}&offset=${offset}`,
        { signal: AbortSignal.timeout(30_000) }
      )
      if (!r.ok) { process.stdout.write(` ${r.status}\n`); break }
      const rows = await r.json()
      if (!Array.isArray(rows) || rows.length === 0) break
      let added = 0
      for (const u of rows) {
        const txid = u.txid ?? u.tx_hash
        const vout = u.vout ?? u.outputIndex ?? u.tx_pos ?? 0
        const sats = u.satoshis ?? u.value ?? 0
        const key  = `${txid}:${vout}`
        if (txid && sats > 0 && !seen.has(key)) { seen.add(key); all.push({ txid, vout, satoshis: sats }); added++ }
      }
      pages++
      process.stdout.write(`\r  GorillaPool: ${all.length.toLocaleString()} UTXOs (page ${pages})  `)
      if (rows.length < LIMIT) break
      if (added === 0) break
      offset += LIMIT
      await sleep(150)
    }
    if (all.length > 0) gpOk = true
  } catch (e) { process.stdout.write(` error: ${e.message}\n`) }

  // ── 2. Bitails — sorted by VALUE DESCENDING (surfaces large UTXOs first) ─
  // This is the key fallback: even 1000 results will contain the biggest UTXOs
  // which is exactly what we need when the balance is in a few large outputs.
  if (!gpOk) {
    process.stdout.write('\n  Trying Bitails (sorted by value desc)...')
    try {
      for (let page = 0; page < 300; page++) {
        const r = await fetch(
          `https://api.bitails.io/address/${address}/unspent?limit=1000&offset=${page * 1000}`,
          { signal: AbortSignal.timeout(30_000) }
        )
        if (!r.ok) { process.stdout.write(` ${r.status}\n`); break }
        const data = await r.json()
        const rows = Array.isArray(data) ? data : (data?.unspent ?? data?.utxos ?? [])
        if (rows.length === 0) break
        let added = 0
        for (const u of rows) {
          const txid = u.txid ?? u.tx_hash
          const vout = u.vout ?? u.tx_pos ?? 0
          const sats = u.satoshis ?? u.value ?? 0
          const key  = `${txid}:${vout}`
          if (txid && sats > 0 && !seen.has(key)) { seen.add(key); all.push({ txid, vout, satoshis: sats }); added++ }
        }
        process.stdout.write(`\r  Bitails: ${all.length.toLocaleString()} UTXOs (page ${page + 1})  `)
        if (rows.length < 1000) break
        await sleep(200)
      }
    } catch (e) { process.stdout.write(` error: ${e.message}\n`) }
  }

  // ── 3. WoC fallback (oldest 1000 — last resort) ──────────────────────────
  if (all.length === 0) {
    process.stdout.write('\n  Trying WoC /unspent (oldest 1000 — last resort)...')
    try {
      const r = await fetch(`${WOC}/address/${address}/unspent`, { signal: AbortSignal.timeout(20_000) })
      if (r.ok) {
        const rows = await r.json()
        for (const u of rows) {
          const key = `${u.tx_hash}:${u.tx_pos}`
          if (!seen.has(key)) { seen.add(key); all.push({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value }) }
        }
      }
    } catch {}
  }

  // Sort largest first so we use the fewest inputs possible
  all.sort((a, b) => b.satoshis - a.satoshis)

  const total = all.reduce((s, u) => s + u.satoshis, 0)
  console.log(`\n  Loaded ${all.length.toLocaleString()} UTXOs | total: ${total.toLocaleString()} sats`)
  return all
}

// ── Build a sweep tx from a batch of UTXOs to multiple outputs ───────────────

async function buildMultiOutputTx(utxos, outputs) {
  const tx = new Transaction()

  for (const u of utxos) {
    const stub = { outputs: [] }
    stub.outputs[u.vout] = { satoshis: u.satoshis }
    tx.addInput({
      sourceTXID: u.txid,
      sourceOutputIndex: u.vout,
      sequence: 0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.satoshis, myScript),
    })
  }

  for (const { addr, sats } of outputs) {
    tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats })
  }

  // Last output gets the change
  tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const changeOut = tx.outputs[tx.outputs.length - 1]
  if (changeOut.satoshis < 0) return null  // fee exceeded input value
  return { hex: tx.toHex(), txid: tx.id('hex'), changeOut }
}

async function buildSweepTx(utxos, toAddr) {
  const tx = new Transaction()
  for (const u of utxos) {
    const stub = { outputs: [] }
    stub.outputs[u.vout] = { satoshis: u.satoshis }
    tx.addInput({
      sourceTXID: u.txid, sourceOutputIndex: u.vout, sequence: 0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.satoshis, myScript),
    })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(toAddr), change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()
  const outSats = tx.outputs[0]?.satoshis ?? 0
  return outSats > 0 ? { hex: tx.toHex(), txid: tx.id('hex'), outSats } : null
}

async function broadcast(hex) {
  try {
    const r = await fetch(ARC_ONE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
      body: JSON.stringify({ rawTx: hex }),
      signal: AbortSignal.timeout(60_000),
    })
    const body = await r.text()
    if (r.ok || body.includes('already') || body.includes('txn-already')) return true
    console.log(`  ARC error ${r.status}: ${body.slice(0, 120)}`)
  } catch (e) { console.log(`  ARC exception: ${e.message}`) }

  try {
    const r = await fetch(`${WOC}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: hex }),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await r.text()
    if (r.ok || body.includes('already')) return true
  } catch {}

  return false
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n💸 Fund New Wallets — from gen1 old orchestrator')
  console.log('═'.repeat(65))
  console.log(`  Source: ${address}  (gen1 old-orch)`)

  // Resolve target addresses
  const targets = []
  for (const e of ENV_FILES) {
    const addr = loadAddress(e.file)
    if (!addr) { console.error(`  ✗ Cannot read address from ${e.file}`); process.exit(1) }
    targets.push({ ...e, addr })
  }

  const totalNeeded = targets.reduce((s, t) => s + t.targetSats, 0)
  console.log(`  Targets: ${targets.length} wallets | total needed: ${totalNeeded.toLocaleString()} sats (${(totalNeeded/1e8).toFixed(4)} BSV ≈ $${(totalNeeded/1e8*BSV_PRICE).toFixed(2)})\n`)

  for (const t of targets) console.log(`  ${t.label.padEnd(14)} → ${t.addr}  (${t.targetSats.toLocaleString()} sats)`)
  console.log()

  // Load all UTXOs via paginated GorillaPool
  const utxos   = await fetchAllUtxos()
  const totalIn = utxos.reduce((s, u) => s + u.satoshis, 0)
  console.log(`  Total available: ${totalIn.toLocaleString()} sats (${(totalIn/1e8).toFixed(4)} BSV)\n`)

  if (totalIn < totalNeeded) {
    const short = totalNeeded - totalIn
    console.error(`  ✗ INSUFFICIENT: short by ${short.toLocaleString()} sats`)
    process.exit(1)
  }

  // Strategy: sweep all UTXOs in batches to the source address first (consolidation),
  // then send one final tx to all 11 target wallets from the consolidated output.
  //
  // But since we can't wait for block confirmation, we instead send one batch
  // directly to each target wallet sequentially — each batch covers one wallet.

  // Sort targets so we send the largest amounts first (orchestrator first)
  const remaining = [...targets]
  const batchCount = Math.ceil(utxos.length / BATCH)

  console.log(`  Strategy: ${batchCount} batches × ${BATCH} UTXOs → send one target per batch`)
  console.log('─'.repeat(65))

  let utxoIdx  = 0
  let funded   = []
  let batchNum = 0

  for (const target of remaining) {
    // Collect enough UTXOs to cover this target + fee buffer
    const batchUtxos = []
    let batchTotal   = 0
    const needed     = target.targetSats + 20_000  // 20k sat fee buffer per batch

    while (utxoIdx < utxos.length && batchTotal < needed) {
      const u = utxos[utxoIdx++]
      batchUtxos.push(u)
      batchTotal += u.satoshis
    }

    if (batchTotal < MIN_BATCH_SATS) {
      console.log(`  ${target.label}: ✗ ran out of UTXOs (only ${batchTotal} sats left)`)
      continue
    }

    batchNum++
    process.stdout.write(`  Batch ${batchNum}: ${batchUtxos.length} UTXOs (${batchTotal.toLocaleString()} sats) → ${target.label}... `)

    // Build tx: sweep batch → target amount to target addr, change back to source
    const tx = new Transaction()
    for (const u of batchUtxos) {
      const stub = { outputs: [] }
      stub.outputs[u.vout] = { satoshis: u.satoshis }
      tx.addInput({
        sourceTXID: u.txid, sourceOutputIndex: u.vout, sequence: 0xffffffff,
        sourceTransaction: stub,
        unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.satoshis, myScript),
      })
    }
    // Primary output: exactly targetSats to the new wallet
    tx.addOutput({ lockingScript: new P2PKH().lock(target.addr), satoshis: target.targetSats })
    // Change back to source wallet for next batch
    tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true })
    await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
    await tx.sign()

    const changeBack = tx.outputs[1]?.satoshis ?? 0
    const hex        = tx.toHex()

    if (changeBack < 0) {
      console.log(`✗ fee exceeded input — batch too small`)
      continue
    }

    const ok = await broadcast(hex)
    if (ok) {
      console.log(`✓  txid: ${tx.id('hex').slice(0, 20)}…  change back: ${changeBack.toLocaleString()} sats`)
      funded.push(target.label)
      // Inject the change UTXO back into the pool so next batch can spend it
      utxos.splice(utxoIdx, 0, {
        txid: tx.id('hex'),
        vout: 1,
        satoshis: changeBack,
      })
    } else {
      console.log(`✗ broadcast failed — re-run script to retry`)
    }

    await sleep(1_500)
  }

  console.log('\n' + '═'.repeat(65))
  console.log(`\n  ✅ Funded ${funded.length}/${targets.length}: ${funded.join(', ')}`)
  console.log('\n  Next steps:')
  console.log('    node scripts/balance-all.js   — verify all new wallets received funds')
  console.log('    node scripts/fanout.js        — split UTXOs for high-frequency use')
  console.log('    npm start                     — launch full 24h run\n')
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
