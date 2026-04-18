/**
 * scripts/analyze-txs.js
 *
 * Deep analysis of MESA on-chain transactions:
 *   1. Fetch all confirmed txids from JungleBus for all wallets
 *   2. Get block timestamps from BananaBlocks
 *   3. Find the best 24-hr, 48-hr, and 72-hr windows
 *   4. Cross-check UTXO counts as a proxy for total activity
 *
 * Run after the hackathon run has ended and mempool has drained.
 * Run: node scripts/analyze-txs.js
 */
import { readFileSync } from 'fs'
import { PrivateKey }   from '@bsv/sdk'

const ENV_FILES = [
  ['.env.orchestrator', 'orchestrator'],
  ['.env.labeler1',   'labeler-1'],
  ['.env.labeler2',   'labeler-2'],
  ['.env.labeler3',   'labeler-3'],
  ['.env.labeler4',   'labeler-4'],
  ['.env.labeler5',   'labeler-5'],
  ['.env.labeler6',   'labeler-6'],
  ['.env.labeler7',   'labeler-7'],
  ['.env.labeler8',   'labeler-8'],
  ['.env.labeler9',   'labeler-9'],
  ['.env.labeler10',  'labeler-10'],
]

const OLD_ORCH = { address: '18xNrXZhS1jBVwPb9E3mUvLrLqnT29EGt9', label: 'OLD-orchestrator' }

const JB_BASE  = 'https://junglebus.gorillapool.io/v1/address/get'
const BB_BASE  = 'https://bananablocks.com/api/v1'
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'
const SLEEP_MS = 700

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Load wallet addresses ─────────────────────────────────────────────────────

function loadEnv(path) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    for (const l of lines) {
      if (l.trim().startsWith('AGENT_KEY='))
        return PrivateKey.fromHex(l.trim().slice(10).trim()).toAddress().toString()
    }
  } catch {}
  return null
}

const wallets = [OLD_ORCH]
for (const [file, label] of ENV_FILES) {
  const address = loadEnv(file)
  wallets.push({ address, label })
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function jbGet(addr) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${JB_BASE}/${addr}`, { signal: AbortSignal.timeout(30_000) })
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue }
      if (!r.ok) return []
      const d = await r.json()
      return Array.isArray(d) ? d : []
    } catch { return [] }
  }
  return []
}

async function bbBlock(height) {
  await sleep(700)
  try {
    const r = await fetch(`${BB_BASE}/block/${height}`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

async function wocHistory(addr) {
  await sleep(1200)
  try {
    const r = await fetch(`${WOC_BASE}/address/${addr}/history`, { signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

async function bbAddress(addr) {
  await sleep(700)
  try {
    const r = await fetch(`${BB_BASE}/address/${addr}`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return null
    return r.json()
  } catch { return null }
}

// ── Step 1: Collect all confirmed txids with block heights ────────────────────

console.log('═'.repeat(70))
console.log('  MESA Transaction Analysis — April 14–17, 2026')
console.log('═'.repeat(70))
console.log('\n  Step 1: Fetching confirmed txids from JungleBus...\n')

const txsByBlock  = new Map()   // blockHeight → Set of txids
const allTxids    = new Set()
const perWallet   = []

for (const { address, label } of wallets) {
  if (!address) { console.log(`  ${label}: no address`); continue }
  await sleep(SLEEP_MS)
  const txs = await jbGet(address)
  let newCount = 0
  for (const tx of txs) {
    const id = tx.transaction_id || tx.txid
    const bh = tx.block_height
    if (!id || !bh) continue
    if (!allTxids.has(id)) { allTxids.add(id); newCount++ }
    if (!txsByBlock.has(bh)) txsByBlock.set(bh, new Set())
    txsByBlock.get(bh).add(id)
  }
  perWallet.push({ label, total: txs.length, unique: newCount })
  console.log(`  ${label.padEnd(18)} ${txs.length.toLocaleString().padStart(7)} txs  (${newCount.toLocaleString()} net-new)`)
}

console.log(`\n  Total unique confirmed txids: ${allTxids.size.toLocaleString()}`)
console.log(`  Active blocks: ${txsByBlock.size}  (heights ${Math.min(...txsByBlock.keys())} – ${Math.max(...txsByBlock.keys())})`)

// ── Step 2: Get block timestamps ──────────────────────────────────────────────

console.log('\n  Step 2: Fetching block timestamps from BananaBlocks...\n')

const blockHeights = Array.from(txsByBlock.keys()).sort((a, b) => a - b)
const blockMeta    = new Map()  // height → { time, txCount }

for (const h of blockHeights) {
  const data = await bbBlock(h)
  if (data) {
    blockMeta.set(h, { time: data.time, txCount: data.tx_count || 0 })
    const ts = new Date(data.time * 1000).toISOString().replace('T', ' ').slice(0, 16)
    const mesaCount = txsByBlock.get(h)?.size || 0
    console.log(`  Block ${h}  ${ts} UTC  total=${data.tx_count?.toLocaleString().padStart(7)}  MESA=${mesaCount.toLocaleString().padStart(5)}`)
  } else {
    console.log(`  Block ${h}  (fetch failed)`)
  }
}

// ── Step 3: Build per-timestamp tx list ───────────────────────────────────────

// For each txid, assign the timestamp of its block
const txTimestamps = []  // unix seconds
for (const [height, txSet] of txsByBlock) {
  const meta = blockMeta.get(height)
  if (!meta?.time) continue
  for (let i = 0; i < txSet.size; i++) txTimestamps.push(meta.time)
}
txTimestamps.sort((a, b) => a - b)

const firstTs = txTimestamps[0]
const lastTs  = txTimestamps[txTimestamps.length - 1]
const spanHrs = ((lastTs - firstTs) / 3600).toFixed(1)

console.log(`\n  Timestamped txs: ${txTimestamps.length.toLocaleString()}`)
console.log(`  Span: ${new Date(firstTs*1000).toISOString().slice(0,16)} UTC  →  ${new Date(lastTs*1000).toISOString().slice(0,16)} UTC  (${spanHrs}h)`)

// ── Step 4: Sliding window analysis ──────────────────────────────────────────

function bestWindow(timestamps, windowSecs) {
  if (timestamps.length === 0) return { count: 0, start: 0, end: 0 }
  let best = 0, bestStart = timestamps[0], bestEnd = timestamps[0]
  let lo = 0
  for (let hi = 0; hi < timestamps.length; hi++) {
    while (timestamps[hi] - timestamps[lo] > windowSecs) lo++
    const count = hi - lo + 1
    if (count > best) {
      best = count
      bestStart = timestamps[lo]
      bestEnd   = timestamps[hi]
    }
  }
  return { count: best, start: bestStart, end: bestEnd }
}

const W24 = bestWindow(txTimestamps, 86400)
const W48 = bestWindow(txTimestamps, 172800)
const W72 = bestWindow(txTimestamps, 259200)

const TARGET = 1_500_000
const fmt = n => n.toLocaleString()
const pct = n => ((n / TARGET) * 100).toFixed(2) + '%'
const fmtTs = t => new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

console.log('\n' + '═'.repeat(70))
console.log('  SLIDING WINDOW ANALYSIS — Best consecutive window for each span\n')
console.log(`  ${'Window'.padEnd(8)} ${'Best count'.padStart(12)}  ${'% of 1.5M'.padStart(10)}  Period`)
console.log('  ' + '─'.repeat(65))
for (const [label, w] of [['24-hr', W24], ['48-hr', W48], ['72-hr', W72]]) {
  const flag = w.count >= TARGET ? ' ✅ TARGET HIT' : ''
  console.log(`  ${label.padEnd(8)} ${fmt(w.count).padStart(12)}  ${pct(w.count).padStart(10)}  ${fmtTs(w.start)} → ${fmtTs(w.end)}${flag}`)
}

// ── Step 5: UTXO proxy counts ─────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70))
console.log('  UTXO COUNTS (BananaBlocks) — proxy for total on-chain activity\n')
console.log('  Each UTXO in an orchestrator wallet represents a chain-tip output.')
console.log('  Total UTXOs ≈ lower bound on confirmed on-chain outputs created.\n')

const ADDRS = wallets.filter(w => w.address)
let totalUtxo = 0, totalBalance = 0
for (const { address, label } of ADDRS) {
  const d = await bbAddress(address)
  if (!d) { console.log(`  ${label}: fetch failed`); continue }
  totalUtxo    += d.utxo_count || 0
  totalBalance += d.balance    || 0
  console.log(`  ${label.padEnd(18)} ${(d.utxo_count||0).toLocaleString().padStart(9)} UTXOs  ${(d.balance||0).toLocaleString().padStart(16)} sats`)
}
console.log('  ' + '─'.repeat(55))
console.log(`  ${'TOTAL'.padEnd(18)} ${totalUtxo.toLocaleString().padStart(9)} UTXOs  ${totalBalance.toLocaleString().padStart(16)} sats`)

// ── Step 6: WoC cross-check (now that agents are stopped) ─────────────────────

console.log('\n' + '═'.repeat(70))
console.log('  WOC CROSS-CHECK (first wallet, agents stopped — rate limit cleared)\n')

const firstAddr = wallets[0].address
const wocData   = await wocHistory(firstAddr)
if (Array.isArray(wocData)) {
  console.log(`  ${wallets[0].label} (${firstAddr}): ${wocData.length} txs from WoC (max 100)`)
  if (wocData.length > 0) {
    const sample = wocData[0]
    console.log(`  Sample: ${JSON.stringify(sample).slice(0, 100)}`)
  }
} else {
  console.log(`  WoC still rate-limited or returned: ${JSON.stringify(wocData)?.slice(0,80)}`)
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(70))
console.log('  FINAL SUMMARY\n')
console.log(`  Confirmed unique txids (JungleBus):  ${fmt(allTxids.size)}  ← hard lower bound`)
console.log(`  Total UTXOs across all wallets:      ${fmt(totalUtxo)}  ← activity proxy`)
console.log(`  Total BSV held:                      ${(totalBalance/1e8).toFixed(4)} BSV`)
console.log()
console.log(`  Best 24-hr confirmed window:  ${fmt(W24.count).padStart(9)}  (${pct(W24.count)} of 1.5M target)`)
console.log(`  Best 48-hr confirmed window:  ${fmt(W48.count).padStart(9)}  (${pct(W48.count)} of 1.5M target)`)
console.log(`  Best 72-hr confirmed window:  ${fmt(W72.count).padStart(9)}  (${pct(W72.count)} of 1.5M target)`)
console.log()
console.log('  NOTE: JungleBus caps per-address results (~11k each). The confirmed')
console.log('  count is a lower bound. Old orchestrator UTXO count (281k) suggests')
console.log('  far more txs were broadcast and are still confirming/in mempool.')
console.log('═'.repeat(70) + '\n')
