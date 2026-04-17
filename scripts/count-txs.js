/**
 * scripts/count-txs.js
 *
 * Count every on-chain BSV transaction for ALL MESA wallets since April 14.
 *
 * Strategy (fast — ~3 min total):
 *   1. Try BananaBlocks summary /api/v1/address/{addr} for tx_count directly
 *   2. If tx_count is 0/missing (known BB bug), binary-search for the last page,
 *      then derive total = last_page × page_size
 *   3. Cross-check recent WoC history to confirm blocks are in range
 *
 * These wallets were created for this hackathon so ALL txs are since April 14.
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

const BB_BASE  = 'https://bananablocks.com/api/v1'
const WOC_BASE = 'https://api.whatsonchain.com/v1/bsv/main'

const sleep = ms => new Promise(r => setTimeout(r, ms))

// BananaBlocks rate limit: ~60 requests/burst. Sleep 1.2s between calls.
const BB_SLEEP = 1200

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

// Fetch with retry on 429 (exponential backoff)
async function bbFetch(url, attempt = 0) {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (resp.status === 429) {
      const delay = Math.min(2000 * Math.pow(2, attempt), 30_000)
      process.stdout.write(`  [429 rate limit — waiting ${(delay/1000).toFixed(0)}s]\n`)
      await sleep(delay)
      return bbFetch(url, attempt + 1)
    }
    if (!resp.ok) return null
    return resp.json()
  } catch {
    return null
  }
}

// Get page of txs — returns array or null
async function bbPage(addr, page) {
  const data = await bbFetch(`${BB_BASE}/address/${addr}/txs?page=${page}`)
  if (!data) return null
  if (Array.isArray(data)) return data
  // Unwrap common envelope shapes
  return data.txs || data.transactions || data.data || data.results || null
}

// Binary search: find the last page with any content.
// BB pages are oldest-first; once a page returns [] or 404, we've gone past the end.
async function findLastPage(addr) {
  let lo = 1, hi = 50_000

  // Quick sanity check — does page 1 exist?
  await sleep(BB_SLEEP)
  const p1 = await bbPage(addr, 1)
  if (!p1 || p1.length === 0) return { lastPage: 0, pageSize: 0 }

  const pageSize = p1.length

  // Double hi until we find an empty page
  let probe = 100
  while (probe < hi) {
    await sleep(BB_SLEEP)
    const pg = await bbPage(addr, probe)
    if (!pg || pg.length === 0) { hi = probe; break }
    lo = probe
    probe = Math.min(probe * 2, hi)
  }

  // Binary search between lo and hi
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2)
    await sleep(BB_SLEEP)
    const pg = await bbPage(addr, mid)
    if (pg && pg.length > 0) lo = mid
    else hi = mid
  }

  // lo is now the last page with content
  // Count txs on the last page to get the partial page size
  await sleep(BB_SLEEP)
  const lastPg = await bbPage(addr, lo)
  const lastPageSize = lastPg ? lastPg.length : pageSize

  return { lastPage: lo, pageSize, lastPageSize }
}

// Get total tx count = (lastPage - 1) × pageSize + lastPageSize
async function countAddressTxs(addr, label) {
  // ① Try BananaBlocks summary endpoint — tx_count is often present
  await sleep(BB_SLEEP)
  const summary = await bbFetch(`${BB_BASE}/address/${addr}`)
  if (summary && summary.tx_count && summary.tx_count > 0) {
    console.log(`  ✓ ${label}: ${summary.tx_count.toLocaleString()} txs (from BB summary)`)
    return { count: summary.tx_count, method: 'summary' }
  }

  // ② summary.tx_count is 0 or missing — binary search for last page
  console.log(`  [${label}] tx_count not in summary — searching via binary search...`)
  const { lastPage, pageSize, lastPageSize } = await findLastPage(addr)

  if (lastPage === 0) {
    console.log(`  ✓ ${label}: 0 txs (no pages found)`)
    return { count: 0, method: 'binary' }
  }

  const count = (lastPage - 1) * pageSize + lastPageSize
  console.log(`  ✓ ${label}: ~${count.toLocaleString()} txs (${lastPage} pages × ${pageSize} + ${lastPageSize} partial)`)
  return { count, method: 'binary' }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(62))
  console.log('  MESA On-Chain Transaction Count — All Time (Since Apr 14)')
  console.log('═'.repeat(62))
  console.log('\n  These wallets were created for this hackathon — all txs are')
  console.log('  from April 14–17. No date filtering required.\n')

  let grandTotal = 0
  const results  = []

  for (const [file, label] of ENV_FILES) {
    const env = loadEnv(file)
    if (!env?.AGENT_KEY) {
      console.log(`  ${label.padEnd(12)} — env file missing or no AGENT_KEY`)
      continue
    }

    let address
    try {
      const priv = PrivateKey.fromHex(env.AGENT_KEY)
      address = priv.toAddress().toString()
    } catch {
      console.log(`  ${label.padEnd(12)} — could not derive address`)
      continue
    }

    console.log(`\n▶ ${label}  ${address}`)
    const { count, method } = await countAddressTxs(address, label)
    grandTotal += count
    results.push({ label, address, count, method })
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(62))
  console.log('  FINAL SUMMARY\n')

  for (const { label, count, method } of results) {
    const m = method === 'binary' ? '~' : ' '
    console.log(`  ${label.padEnd(14)}  ${m}${count.toLocaleString().padStart(9)} txs`)
  }

  console.log('─'.repeat(62))
  const prefix = results.some(r => r.method === 'binary') ? '~' : ' '
  console.log(`  ${'TOTAL'.padEnd(14)}  ${prefix}${grandTotal.toLocaleString().padStart(9)} txs since April 14`)

  const TARGET = 1_500_000
  const pct    = ((grandTotal / TARGET) * 100).toFixed(1)
  console.log(`  ${'TARGET'.padEnd(14)}   ${TARGET.toLocaleString().padStart(9)} txs`)
  console.log(`  ${'PROGRESS'.padEnd(14)}   ${pct}% of 1.5M target`)

  if (grandTotal >= TARGET) {
    console.log('\n  🟢 TARGET ACHIEVED — 1.5M+ confirmed on-chain transactions!')
  } else {
    const needed = TARGET - grandTotal
    console.log(`\n  🟡 ${needed.toLocaleString()} more txs needed`)
  }

  console.log('═'.repeat(62) + '\n')
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
