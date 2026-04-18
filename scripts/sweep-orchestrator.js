/**
 * scripts/sweep-orchestrator.js
 *
 * Sweeps any BSV wallet back to a single UTXO.
 * WoC /unspent caps at 1000 — useless for high-UTXO wallets.
 * Uses GorillaPool → Bitails → WoC in fallback order for full UTXO enumeration.
 *
 * Strategy:
 *   Round 1: fetch ALL UTXOs, batch 400 at a time → N consolidation txs
 *   Round 2: if ≤ 20 batches, chains immediately via ARC bulk.
 *            if > 20 batches, wait for next block then re-run.
 *
 * Usage:
 *   node --env-file=.env.orchestrator scripts/sweep-orchestrator.js
 *   node scripts/sweep-orchestrator.js --key <privkey_hex> [--to <address>]
 *
 * Examples:
 *   # Sweep old orchestrator to current one:
 *   node scripts/sweep-orchestrator.js \
 *     --key 9b080c6221282881e08d631fe9c225360b32db6dadc0f917ecf760f39a15b746 \
 *     --to 1CXWMmLfqF68jHtLiUGcm4hYW5Me75CUaX
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'

const KEY = (() => {
  const idx = process.argv.indexOf('--key')
  return idx >= 0 ? process.argv[idx + 1] : process.env.AGENT_KEY
})()

if (!KEY) {
  console.error('Usage: node --env-file=.env.orchestrator scripts/sweep-orchestrator.js')
  console.error('   or: node scripts/sweep-orchestrator.js --key <privkey_hex> [--to <address>]')
  process.exit(1)
}

const DST_ADDRESS = (() => {
  const idx = process.argv.indexOf('--to')
  return idx >= 0 ? process.argv[idx + 1] : null
})()

const priv      = PrivateKey.fromHex(KEY)
const address   = priv.toPublicKey().toAddress('mainnet').toString()
const myScript  = new P2PKH().lock(address)
const dstAddr   = DST_ADDRESS || address  // sweep back to self if no --to

const ARC_BULK  = 'https://arc.gorillapool.io/v1/txs'
const ARC_SINGLE = 'https://arc.gorillapool.io/v1/tx'
const GP_UTXOS  = `https://v3.ordinals.gorillapool.io/utxos/${address}?bsv20=false`
const WOC       = 'https://api.whatsonchain.com/v1/bsv/main'
const FEE_RATE  = 500   // sat/KB — enough to get mined promptly
const BATCH     = 400   // inputs per consolidation tx (safe BSV tx size)

const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log(`\n🧹 Sweep Orchestrator — ${address}`)
if (DST_ADDRESS) console.log(`   → Destination: ${dstAddr}`)
else             console.log(`   → Sweeping back to self`)
console.log()

// ── Step 1: Fetch ALL confirmed UTXOs ────────────────────────────────────────
// Try GorillaPool → Bitails → WoC in order.
// GorillaPool and Bitails both support pagination and have no hard cap.
// WoC is the last resort — caps at 1000, so for wallets with 100K+ UTXOs
// it only returns a fraction (oldest/smallest first).

async function fetchGorillaPool() {
  const all = []
  let offset = 0
  const limit = 1000
  const base  = `https://v3.ordinals.gorillapool.io/utxos/${address}?bsv20=false`

  while (true) {
    try {
      const r = await fetch(`${base}&limit=${limit}&offset=${offset}`, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) { console.log(`   GorillaPool HTTP ${r.status} at offset ${offset}`); break }
      const data = await r.json()
      const rows = Array.isArray(data) ? data : (data?.utxos ?? data?.data ?? [])
      if (rows.length === 0) break
      for (const u of rows) {
        const txid = u.txid ?? u.tx_hash
        const vout = u.vout ?? u.tx_pos ?? 0
        const sats = u.satoshis ?? u.value ?? 0
        if (txid && sats > 0) all.push({ txid, vout, satoshis: sats })
      }
      process.stdout.write(`\r   GorillaPool: ${all.length.toLocaleString()} UTXOs fetched...`)
      if (rows.length < limit) break
      offset += limit
      await sleep(250)
    } catch (err) {
      console.log(`\n   GorillaPool error at offset ${offset}: ${err.message}`)
      break
    }
  }
  if (all.length > 0) process.stdout.write('\n')
  return all
}

async function fetchBitails() {
  const all = []
  let offset = 0
  const limit = 1000

  while (true) {
    try {
      const r = await fetch(
        `https://api.bitails.io/address/${address}/unspent?limit=${limit}&offset=${offset}`,
        { signal: AbortSignal.timeout(60_000) }
      )
      if (!r.ok) { console.log(`   Bitails HTTP ${r.status} at offset ${offset}`); break }
      const data  = await r.json()
      const rows  = Array.isArray(data) ? data : (data?.unspent ?? data?.utxos ?? data?.data ?? [])
      if (rows.length === 0) break
      for (const u of rows) {
        const txid = u.txid ?? u.tx_hash
        const vout = u.vout ?? u.tx_pos ?? u.n ?? 0
        const sats = u.satoshis ?? u.value ?? 0
        if (txid && sats > 0) all.push({ txid, vout, satoshis: sats })
      }
      process.stdout.write(`\r   Bitails: ${all.length.toLocaleString()} UTXOs fetched...`)
      if (rows.length < limit) break
      offset += limit
      await sleep(400)
    } catch (err) {
      console.log(`\n   Bitails error at offset ${offset}: ${err.message}`)
      break
    }
  }
  if (all.length > 0) process.stdout.write('\n')
  return all
}

async function fetchAllUtxos() {
  console.log('① Fetching UTXOs — trying GorillaPool, Bitails, WoC in order...\n')

  let all = await fetchGorillaPool()
  if (all.length > 0) { console.log(`   GorillaPool: ${all.length.toLocaleString()} UTXOs total`); return all }

  console.log('   GorillaPool returned 0 — trying Bitails...')
  all = await fetchBitails()
  if (all.length > 0) { console.log(`   Bitails: ${all.length.toLocaleString()} UTXOs total`); return all }

  console.log('   Bitails returned 0 — falling back to WoC (CAPPED AT 1000)...')
  const r = await fetch(`${WOC}/address/${address}/unspent`)
  if (!r.ok) throw new Error(`WoC /unspent failed: ${r.status}`)
  const raw = await r.json()
  for (const u of raw) all.push({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value })
  if (all.length >= 1000) {
    console.log(`   ⚠ WoC returned ${all.length} UTXOs — likely capped. Actual UTXO count is much higher.`)
    console.log('   ⚠ This sweep will only recover a fraction of the balance.')
    console.log('   ⚠ Re-run when GorillaPool or Bitails is back online for a full sweep.')
  } else {
    console.log(`   WoC returned ${all.length} UTXOs`)
  }
  return all
}

// ── Step 2: Build and broadcast a consolidation tx ──────────────────────────

// broadcast a tx that spends only confirmed (on-chain) inputs — single-tx ARC call is safe.
// Round 1 always uses this path: all GorillaPool UTXOs are confirmed.
// Round 2 uses the bulk-chain path (broadcastWithParents) since its inputs are unconfirmed.
async function broadcastConfirmed(hex) {
  // ARC single-tx endpoint with X-WaitFor: STORED
  try {
    const r = await fetch(ARC_SINGLE, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
      body:    JSON.stringify({ rawTx: hex }),
      signal:  AbortSignal.timeout(45_000),
    })
    const body = await r.text()
    if (r.ok || body.includes('already') || body.includes('txn-already-in-mempool')) return true
    console.log(`   ARC ${r.status}: ${body.slice(0, 100)}`)
  } catch (e) {
    console.log(`   ARC error: ${e.message}`)
  }

  // WoC fallback
  try {
    const r = await fetch(`${WOC}/tx/raw`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ txhex: hex }),
      signal:  AbortSignal.timeout(30_000),
    })
    const body = await r.text()
    if (r.ok || body.includes('already')) return true
    console.log(`   WoC ${r.status}: ${body.slice(0, 100)}`)
  } catch (e) {
    console.log(`   WoC error: ${e.message}`)
  }

  return false
}

// broadcast a tx whose inputs are unconfirmed — must submit [parent1, parent2, ..., child]
// to ARC's bulk endpoint so ARC validates the chain without needing miners to confirm first.
// Only safe when parent count is small (< ~20): each parent tx can be 60KB+ so bulk
// payloads of 500+ parents would exceed ARC's request size limit.
async function broadcastWithParents(parentHexes, childHex) {
  const chain = [...parentHexes.map(h => ({ rawTx: h })), { rawTx: childHex }]
  try {
    const r = await fetch(ARC_BULK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
      body:    JSON.stringify(chain),
      signal:  AbortSignal.timeout(60_000),
    })
    const body = await r.text()
    if (r.ok || body.includes('already') || body.includes('txn-already-in-mempool')) return true
    console.log(`   ARC bulk ${r.status}: ${body.slice(0, 120)}`)
    return false
  } catch (e) {
    console.log(`   ARC bulk error: ${e.message}`)
    return false
  }
}

async function buildAndBroadcastBatch(utxos, toAddr, label, parentHexes = null) {
  const tx = new Transaction()

  for (const u of utxos) {
    const stub = { outputs: [] }
    stub.outputs[u.vout] = { satoshis: u.satoshis }
    tx.addInput({
      sourceTXID:        u.txid,
      sourceOutputIndex: u.vout,
      sequence:          0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(
        priv, 'all', false, u.satoshis, myScript
      ),
    })
  }

  tx.addOutput({ lockingScript: new P2PKH().lock(toAddr), change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const hex     = tx.toHex()
  const txid    = tx.id('hex')
  const totalIn = utxos.reduce((s, u) => s + u.satoshis, 0)
  const outSats = tx.outputs[0]?.satoshis ?? 0
  const fee     = totalIn - outSats

  if (outSats <= 0) {
    console.log(`   ${label}: dust batch (${totalIn} sats total < fee) — skipped`)
    return null
  }

  const ok = parentHexes
    ? await broadcastWithParents(parentHexes, hex)
    : await broadcastConfirmed(hex)

  const status = ok ? '✓' : '✗'
  console.log(`   ${status} ${label}: ${utxos.length} inputs → ${outSats.toLocaleString()} sats  fee=${fee}  txid=${txid.slice(0, 20)}…`)

  if (!ok) return null

  return { txid, vout: 0, satoshis: outSats, hex }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const allUtxos = await fetchAllUtxos()
const totalSats = allUtxos.reduce((s, u) => s + u.satoshis, 0)

console.log(`\n   Found ${allUtxos.length.toLocaleString()} UTXOs  (${totalSats.toLocaleString()} sats = ${(totalSats/1e8).toFixed(6)} BSV)\n`)

if (allUtxos.length === 0) {
  console.log('Nothing to sweep.')
  process.exit(0)
}

if (allUtxos.length === 1) {
  console.log('Already 1 UTXO — nothing to do.')
  process.exit(0)
}

// ── Round 1: batch-consolidate all UTXOs into one output per batch ────────────

console.log(`② Round 1 — batching ${allUtxos.length.toLocaleString()} UTXOs into chunks of ${BATCH}...\n`)

const round1Outputs = []
const numBatches = Math.ceil(allUtxos.length / BATCH)

for (let i = 0; i < numBatches; i++) {
  const batch   = allUtxos.slice(i * BATCH, (i + 1) * BATCH)
  const label   = `batch ${String(i + 1).padStart(3)}/${numBatches}`
  const output  = await buildAndBroadcastBatch(batch, address, label)
  if (output) round1Outputs.push(output)
  // Stagger submissions to avoid ARC rate limiting
  if (i % 10 === 9) await sleep(1000)
  else await sleep(100)
}

console.log(`\n   Round 1 complete: ${round1Outputs.length} consolidation txs broadcast`)

if (round1Outputs.length === 0) {
  console.log('No txs succeeded — check ARC connectivity.')
  process.exit(1)
}

// ── Round 2: combine batch outputs into one final UTXO ────────────────────────
//
// Round 1 outputs are unconfirmed — ARC requires the full parent chain to validate
// a tx that spends them (bulk endpoint: [parent1, parent2, ..., child]).
// Each parent batch tx can be ~60KB (400 inputs), so with many batches the bulk
// payload becomes too large for ARC. Safe threshold: ≤ 20 parents (≤ ~1.2MB).
//
// If Round 1 produced more than 20 outputs, skip Round 2 and tell the user to
// wait for the next BSV block — then re-run. On re-run, GorillaPool returns the
// confirmed Round 1 outputs and everything fits in a single final batch.

const ROUND2_PARENT_LIMIT = 20

if (round1Outputs.length === 1) {
  const done = round1Outputs[0]
  console.log(`\n✅ Sweep complete — already 1 UTXO!`)
  console.log(`   ${done.satoshis.toLocaleString()} sats → ${dstAddr}`)
  console.log(`   https://whatsonchain.com/tx/${done.txid}`)
  console.log('\n   ⏳ Wait ~10 min for the next BSV block to confirm.')
  process.exit(0)
}

if (round1Outputs.length > ROUND2_PARENT_LIMIT) {
  const totalSweep = round1Outputs.reduce((s, o) => s + o.satoshis, 0)
  console.log(`\n⏳ Round 1 produced ${round1Outputs.length} unconfirmed outputs.`)
  console.log(`   Sending them all as parents in one ARC call would be ~${Math.round(round1Outputs.length * 60 / 1024)}MB — too large.`)
  console.log(`   Wait for the next BSV block (~10 min), then re-run:`)
  console.log()
  console.log(`     node --env-file=.env.orchestrator scripts/sweep-orchestrator.js${DST_ADDRESS ? ` --to ${DST_ADDRESS}` : ''}`)
  console.log()
  console.log(`   On re-run GorillaPool will return the ${round1Outputs.length} confirmed outputs`)
  console.log(`   and this script will consolidate them into 1 UTXO (${(totalSweep / 1e8).toFixed(6)} BSV).`)
  process.exit(0)
}

// Small number of Round 1 outputs (≤ 20) — safe to chain immediately.
// Pass parent hexes so ARC's bulk endpoint gets [parent1..N, child] in one call.
console.log(`\n③ Round 2 — consolidating ${round1Outputs.length} outputs into 1 (chain broadcast)...\n`)

await sleep(2000)  // brief pause for ARC to index Round 1 txs

const parentHexes = round1Outputs.map(o => o.hex)
const final = await buildAndBroadcastBatch(round1Outputs, dstAddr, 'final', parentHexes)

if (final) {
  console.log(`\n✅ Sweep complete!`)
  console.log(`   Final UTXO: ${final.satoshis.toLocaleString()} sats → ${dstAddr}`)
  console.log(`   https://whatsonchain.com/tx/${final.txid}`)
  console.log('\n   ⏳ Wait ~10 min for the next BSV block to confirm.')
} else {
  console.log(`\n⚠ Round 2 broadcast failed — Round 1 txs are still in mempool.`)
  console.log(`  Wait for the next block then re-run to finish:`)
  console.log(`    node --env-file=.env.orchestrator scripts/sweep-orchestrator.js${DST_ADDRESS ? ` --to ${DST_ADDRESS}` : ''}`)
}
