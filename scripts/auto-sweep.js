/**
 * scripts/auto-sweep.js
 *
 * Runs sweep-orchestrator.js on a loop every 15 minutes until the wallet
 * returns only dust (nothing worth sweeping). Each BSV block confirms the
 * previous batch so Bitails exposes the next 1000 UTXOs.
 *
 * Usage:
 *   node scripts/auto-sweep.js --key <privkey_hex> --to <address>
 *
 * Example:
 *   node scripts/auto-sweep.js --key 9b080c6221282881e08d631fe9c225360b32db6dadc0f917ecf760f39a15b746 --to 1CXWMmLfqF68jHtLiUGcm4hYW5Me75CUaX
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'

const KEY_IDX = process.argv.indexOf('--key')
const TO_IDX  = process.argv.indexOf('--to')
const KEY     = KEY_IDX >= 0 ? process.argv[KEY_IDX + 1] : null
const DST     = TO_IDX  >= 0 ? process.argv[TO_IDX  + 1] : null

if (!KEY || !DST) {
  console.error('Usage: node scripts/auto-sweep.js --key <privkey_hex> --to <address>')
  process.exit(1)
}

const INTERVAL_MS  = 15 * 60 * 1000   // 15 minutes between runs
const FEE_RATE     = 500
const BATCH        = 400

const priv     = PrivateKey.fromHex(KEY)
const address  = priv.toPublicKey().toAddress('mainnet').toString()
const myScript = new P2PKH().lock(address)

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC_BULK = 'https://arc.gorillapool.io/v1/txs'
const ARC_ONE  = 'https://arc.gorillapool.io/v1/tx'

const sleep = ms => new Promise(r => setTimeout(r, ms))

console.log(`\n🔁 Auto-Sweep — ${address}`)
console.log(`   → ${DST}`)
console.log(`   Interval: 15 min between rounds\n`)

// ── UTXO fetch (GorillaPool paginated → Bitails → WoC fallback) ──────────────

async function fetchUtxos() {
  const seen = new Set()
  const all  = []

  // GorillaPool — paginated, no hard cap, fastest drain
  let gpOk = false
  try {
    const LIMIT = 1000
    let offset  = 0
    let pages   = 0
    while (pages < 300) {  // safety cap: 300K UTXOs max
      const r = await fetch(
        `https://v3.ordinals.gorillapool.io/utxos/${address}?bsv20=false&limit=${LIMIT}&offset=${offset}`,
        { signal: AbortSignal.timeout(30_000) }
      )
      if (!r.ok) break
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
      if (rows.length < LIMIT) break   // last page
      if (added === 0) break            // broken pagination guard
      offset += LIMIT
      await sleep(150)                  // gentle rate-limit
    }
    if (all.length > 0) {
      gpOk = true
      console.log(`  GorillaPool: ${all.length.toLocaleString()} UTXOs (${pages} pages)`)
    }
  } catch (e) {
    console.log(`  GorillaPool error: ${e.message} — trying Bitails`)
  }

  // Bitails fallback (top 1000 by value, broken pagination — single page only)
  if (!gpOk) {
    try {
      const r = await fetch(
        `https://api.bitails.io/address/${address}/unspent?limit=1000&offset=0`,
        { signal: AbortSignal.timeout(30_000) }
      )
      if (r.ok) {
        const data = await r.json()
        const rows = Array.isArray(data) ? data : (data?.unspent ?? data?.utxos ?? [])
        for (const u of rows) {
          const txid = u.txid ?? u.tx_hash
          const vout = u.vout ?? u.tx_pos ?? 0
          const sats = u.satoshis ?? u.value ?? 0
          const key  = `${txid}:${vout}`
          if (txid && sats > 0 && !seen.has(key)) { seen.add(key); all.push({ txid, vout, satoshis: sats }) }
        }
        if (all.length > 0) console.log(`  Bitails: ${all.length} UTXOs (top 1000 by value)`)
      }
    } catch {}
  }

  // WoC final fallback
  if (all.length === 0) {
    try {
      const r = await fetch(`${WOC}/address/${address}/unspent`, { signal: AbortSignal.timeout(20_000) })
      if (r.ok) {
        const rows = await r.json()
        for (const u of rows) all.push({ txid: u.tx_hash, vout: u.tx_pos, satoshis: u.value })
        if (all.length > 0) console.log(`  WoC: ${all.length} UTXOs (capped at 1000)`)
      }
    } catch {}
  }

  return all
}

// ── Build + broadcast one batch ───────────────────────────────────────────────

async function broadcastTx(hex, parentHexes = null) {
  const chain = parentHexes
    ? [...parentHexes.map(h => ({ rawTx: h })), { rawTx: hex }]
    : null

  if (chain) {
    try {
      const r = await fetch(ARC_BULK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
        body: JSON.stringify(chain),
        signal: AbortSignal.timeout(45_000),
      })
      const body = await r.text()
      if (r.ok || body.includes('already')) return true
    } catch {}
  }

  try {
    const r = await fetch(ARC_ONE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
      body: JSON.stringify({ rawTx: hex }),
      signal: AbortSignal.timeout(45_000),
    })
    const body = await r.text()
    if (r.ok || body.includes('already')) return true
  } catch {}

  try {
    const r = await fetch(`${WOC}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: hex }),
      signal: AbortSignal.timeout(20_000),
    })
    if (r.ok || (await r.text()).includes('already')) return true
  } catch {}

  return false
}

async function buildBatch(utxos, toAddr) {
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
  const hex     = tx.toHex()
  const outSats = tx.outputs[0]?.satoshis ?? 0
  return outSats > 0 ? { hex, txid: tx.id('hex'), outSats } : null
}

// ── One sweep round ───────────────────────────────────────────────────────────

async function runOnce(round) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
  console.log(`\n[${now}] Round ${round} — fetching UTXOs...`)

  const utxos    = await fetchUtxos()
  const totalIn  = utxos.reduce((s, u) => s + u.satoshis, 0)
  console.log(`  ${utxos.length.toLocaleString()} UTXOs  ${totalIn.toLocaleString()} sats`)

  if (utxos.length === 0) {
    console.log('  Nothing found — wallet may be empty.')
    return 'empty'
  }

  // Check if everything is dust (can't cover a single batch fee)
  const batches     = Math.ceil(utxos.length / BATCH)
  const firstBatch  = utxos.slice(0, BATCH)
  const firstTotal  = firstBatch.reduce((s, u) => s + u.satoshis, 0)
  const estFee      = 30_000
  if (firstTotal <= estFee) {
    console.log(`  All dust (top ${BATCH} UTXOs = ${firstTotal} sats < ${estFee} sat fee) — done!`)
    return 'dust'
  }

  // Round 1: sweep each batch of confirmed UTXOs
  const r1Outputs = []
  for (let i = 0; i < batches; i++) {
    const batch    = utxos.slice(i * BATCH, (i + 1) * BATCH)
    const batchIn  = batch.reduce((s, u) => s + u.satoshis, 0)
    if (batchIn <= estFee) { console.log(`  batch ${i+1}/${batches}: dust — skipped`); continue }

    const built = await buildBatch(batch, address)
    if (!built) { console.log(`  batch ${i+1}/${batches}: fee > value — skipped`); continue }

    const ok = await broadcastTx(built.hex)
    const st = ok ? '✓' : '✗'
    console.log(`  ${st} batch ${i+1}/${batches}: ${batch.length} inputs → ${built.outSats.toLocaleString()} sats  ${built.txid.slice(0,20)}…`)
    if (ok) r1Outputs.push(built)
    await sleep(200)
  }

  if (r1Outputs.length === 0) return 'failed'

  // Round 2: if few enough outputs, chain them immediately
  if (r1Outputs.length === 1) {
    // Already 1 — re-broadcast to final dest
    const built = await buildBatch(r1Outputs, DST)
    if (built) {
      const ok = await broadcastTx(built.hex, r1Outputs.map(o => o.hex))
      if (ok) console.log(`  ✓ final → ${built.outSats.toLocaleString()} sats to ${DST.slice(0,20)}…  ${built.txid.slice(0,20)}…`)
    }
  } else if (r1Outputs.length <= 20) {
    await sleep(2000)
    const built = await buildBatch(r1Outputs, DST)
    if (built) {
      const ok = await broadcastTx(built.hex, r1Outputs.map(o => o.hex))
      const st = ok ? '✓' : '✗'
      console.log(`  ${st} final: ${r1Outputs.length} → ${built.outSats.toLocaleString()} sats  ${built.txid.slice(0,20)}…`)
    }
  } else {
    const total = r1Outputs.reduce((s, o) => s + o.outSats, 0)
    console.log(`  ${r1Outputs.length} batch outputs in mempool (${total.toLocaleString()} sats) — will consolidate next round after block confirms`)
  }

  return 'ok'
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let round = 1
let consecutive_dust = 0

while (true) {
  const result = await runOnce(round++)

  if (result === 'dust') {
    consecutive_dust++
    if (consecutive_dust >= 2) {
      console.log('\n✅ Done — wallet drained to dust. Nothing more to recover.')
      process.exit(0)
    }
    console.log(`  (will check once more after next block in case higher-value UTXOs confirm)`)
  } else {
    consecutive_dust = 0
  }

  if (result === 'empty' && round > 2) {
    console.log('\n✅ Wallet empty.')
    process.exit(0)
  }

  const next = new Date(Date.now() + INTERVAL_MS).toISOString().slice(0, 19).replace('T', ' ')
  console.log(`\n  ⏳ Next run at ${next} UTC (waiting 15 min for block confirmation)`)
  await sleep(INTERVAL_MS)
}
