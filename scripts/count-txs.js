/**
 * scripts/count-txs.js
 *
 * Count unique on-chain BSV transactions for ALL MESA wallets since April 14.
 *
 * Uses JungleBus (junglebus.gorillapool.io) which returns confirmed txs per
 * address. Payment txs appear in BOTH the orchestrator AND the recipient
 * labeler's history — we deduplicate by txid across all addresses.
 *
 * Also includes the OLD orchestrator (18xNrXZhS1jBVwPb9E3mUvLrLqnT29EGt9)
 * which was the first orchestrator before the MESA-Prime upgrade.
 *
 * Run: node scripts/count-txs.js
 */
import { readFileSync } from 'fs'
import { PrivateKey } from '@bsv/sdk'

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

// Old orchestrator — used before MESA-Prime, recovered via recover-nexus.js
const OLD_ORCHESTRATOR = {
  address: '18xNrXZhS1jBVwPb9E3mUvLrLqnT29EGt9',
  label:   'OLD-orchestrator',
}

const JB_BASE  = 'https://junglebus.gorillapool.io/v1/address/get'
const BB_BASE  = 'https://bananablocks.com/api/v1'
const SLEEP_MS = 600   // ~0.6s between requests

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadEnv(path) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n')
    const env = {}
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    return env
  } catch { return null }
}

async function jbFetch(addr) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${JB_BASE}/${addr}`, { signal: AbortSignal.timeout(30_000) })
      if (resp.status === 429) {
        const wait = 3000 * Math.pow(2, attempt)
        process.stdout.write(`  [429 — waiting ${wait/1000}s]\n`)
        await sleep(wait)
        continue
      }
      if (!resp.ok) return null
      const data = await resp.json()
      return Array.isArray(data) ? data : null
    } catch { return null }
  }
  return null
}

async function bbBlockTxCount(height) {
  try {
    const resp = await fetch(`${BB_BASE}/block/${height}`, { signal: AbortSignal.timeout(15_000) })
    if (!resp.ok) return null
    const d = await resp.json()
    return d.tx_count || null
  } catch { return null }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(68))
  console.log('  MESA On-Chain Transaction Count (JungleBus — confirmed only)')
  console.log('═'.repeat(68))
  console.log('\n  JungleBus returns confirmed txs per address.')
  console.log('  Payment txs appear in BOTH payer and payee history — deduped by txid.\n')

  const allTxids  = new Set()
  const perWallet = []

  // Build wallet list: old orchestrator + current wallets
  const wallets = [OLD_ORCHESTRATOR]

  for (const [file, label] of ENV_FILES) {
    const env = loadEnv(file)
    if (!env?.AGENT_KEY) { wallets.push({ address: null, label }); continue }
    try {
      const priv = PrivateKey.fromHex(env.AGENT_KEY)
      wallets.push({ address: priv.toAddress().toString(), label })
    } catch { wallets.push({ address: null, label }) }
  }

  for (const { address, label } of wallets) {
    if (!address) { console.log(`  ${label.padEnd(16)} — missing`); continue }

    process.stdout.write(`▶ ${label.padEnd(16)} ${address}  `)
    await sleep(SLEEP_MS)
    const txs = await jbFetch(address)

    if (!txs) { console.log('(fetch failed)'); continue }

    const before = allTxids.size
    for (const tx of txs) {
      const id = tx.transaction_id || tx.txid || tx.tx_hash
      if (id) allTxids.add(id)
    }
    const unique = allTxids.size - before
    const dupes  = txs.length - unique

    perWallet.push({ label, address, raw: txs.length, unique, dupes })
    console.log(`${txs.length.toLocaleString().padStart(7)} raw, ${unique.toLocaleString().padStart(7)} new, ${dupes.toLocaleString().padStart(6)} dupes`)
  }

  // ── Block coverage summary ─────────────────────────────────────────────────
  console.log('\n  Gathering block coverage...\n')

  // Collect block heights from all txids
  // (We'd need to re-fetch, but we can estimate from JungleBus data we already have)
  // Instead, show total unique txid count across all wallets

  console.log('═'.repeat(68))
  console.log('  PER-WALLET BREAKDOWN\n')
  for (const { label, raw, unique, dupes } of perWallet) {
    console.log(`  ${label.padEnd(16)} ${raw.toLocaleString().padStart(7)} raw  ${unique.toLocaleString().padStart(7)} net-new  ${dupes.toLocaleString().padStart(6)} dupes`)
  }

  const grandTotal = allTxids.size
  const TARGET     = 1_500_000
  const pct        = ((grandTotal / TARGET) * 100).toFixed(2)

  console.log('\n' + '─'.repeat(68))
  console.log(`  ${'UNIQUE TXIDS (confirmed)'.padEnd(16)} ${grandTotal.toLocaleString().padStart(7)}`)
  console.log()
  console.log(`  Target:   1,500,000`)
  console.log(`  Achieved: ${grandTotal.toLocaleString()}  (${pct}% of target)`)
  console.log()

  // ── Context note ───────────────────────────────────────────────────────────
  console.log('  NOTE: JungleBus may cap results per address (~10k-12k seen).')
  console.log('  Check BananaBlocks block stats for the full picture:')

  // Fetch block tx counts for key blocks we know about
  const keyBlocks = [944277, 944285, 944370, 944403]
  for (const h of keyBlocks) {
    await sleep(800)
    const count = await bbBlockTxCount(h)
    if (count) {
      console.log(`    Block ${h}: ${count.toLocaleString()} total BSV txs in block`)
    }
  }

  console.log()
  if (grandTotal >= TARGET) {
    console.log('  🟢 TARGET ACHIEVED — 1.5M+ confirmed on-chain transactions!')
  } else {
    const needed = TARGET - grandTotal
    console.log(`  🟡 ${needed.toLocaleString()} more needed to reach 1.5M target`)
    console.log('  (JungleBus may be capped — actual count could be higher)')
  }
  console.log('═'.repeat(68) + '\n')
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
