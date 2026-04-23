/**
 * scripts/status.js — Live run health monitor
 *
 * Shows every ~30s (or on-demand with --once):
 *  - Orchestrator UTXO health: confirmed (safe) vs unconfirmed (chain depth risk)
 *  - Time since last BSV block (tells you when UTXOs will reset)
 *  - Whether balance is draining correctly (payments going through)
 *  - Labeler balances + UTXO counts
 *
 * Usage:
 *   node scripts/status.js          # continuous, refreshes every 30s
 *   node scripts/status.js --once   # single snapshot and exit
 *   node scripts/status.js --orch   # orchestrator only (faster)
 *
 * WoC /unspent UTXO height field:
 *   height > 0  → confirmed in block → safe, depth resets to 0
 *   height == 0 → unconfirmed (mempool) → part of a chain, risk of hitting depth 20
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'

const WOC   = 'https://api.whatsonchain.com/v1/bsv/main'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const ONCE  = process.argv.includes('--once')
const ORCH_ONLY = process.argv.includes('--orch')
const INTERVAL_MS = 30_000

// ── Load wallets ─────────────────────────────────────────────────────────────

function loadKey(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) return t.slice('AGENT_KEY='.length).trim()
    }
  } catch {}
  return null
}

function keyToAddress(hex) {
  return PrivateKey.fromHex(hex).toPublicKey().toAddress('mainnet').toString()
}

const WALLETS = [
  { file: '.env.orchestrator', label: 'NEXUS (orch)', isOrch: true  },
  { file: '.env.labeler1',     label: 'ARIA  (L1)',   isOrch: false },
  { file: '.env.labeler2',     label: 'BOLT  (L2)',   isOrch: false },
  { file: '.env.labeler3',     label: 'CIPHER(L3)',   isOrch: false },
  { file: '.env.labeler4',     label: 'DELTA (L4)',   isOrch: false },
  { file: '.env.labeler5',     label: 'ECHO  (L5)',   isOrch: false },
  { file: '.env.labeler6',     label: 'FLUX  (L6)',   isOrch: false },
  { file: '.env.labeler7',     label: 'GRAPH (L7)',   isOrch: false },
  { file: '.env.labeler8',     label: 'HELIX (L8)',   isOrch: false },
  { file: '.env.labeler9',     label: 'IRIS  (L9)',   isOrch: false },
  { file: '.env.labeler10',    label: 'JADE  (L10)',  isOrch: false },
]

// ── WoC fetch helpers (with 429 retry + GorillaPool fallback) ────────────────

async function wocFetch(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (r.ok) return r.json()
      if (r.status === 429) {
        const wait = (i + 1) * 1500
        process.stdout.write(`  [rate-limited, retrying in ${wait}ms]\r`)
        await sleep(wait)
        continue
      }
      throw new Error(`WoC ${r.status}`)
    } catch (e) {
      if (i === retries - 1) throw e
      await sleep(800)
    }
  }
  throw new Error('WoC: max retries exceeded')
}

async function fetchUtxos(address) {
  return wocFetch(`${WOC}/address/${address}/unspent`)
}

async function fetchBalance(address) {
  // Try WoC first, fall back to GorillaPool for balance
  try {
    return await wocFetch(`${WOC}/address/${address}/balance`)
  } catch {
    try {
      const r = await fetch(
        `https://v3.ordinals.gorillapool.io/utxos/${address}?bsv20=false`,
        { signal: AbortSignal.timeout(10_000) }
      )
      if (!r.ok) throw new Error('GP fail')
      const data = await r.json()
      const rows = Array.isArray(data) ? data : (data?.utxos ?? data?.data ?? [])
      const total = rows.reduce((s, u) => s + (u.satoshis ?? u.value ?? 0), 0)
      return { confirmed: total, unconfirmed: 0, _source: 'GorillaPool' }
    } catch {
      return null
    }
  }
}

// Get the latest BSV block time — try WoC chain/info, fall back to block height API
async function fetchLastBlockAge() {
  try {
    const r = await fetch(`${WOC}/chain/info`, { signal: AbortSignal.timeout(10_000) })
    if (r.ok) {
      const info = await r.json()
      const br = await fetch(`${WOC}/block/hash/${info.bestblockhash}`, { signal: AbortSignal.timeout(10_000) })
      if (br.ok) {
        const block = await br.json()
        const ageSecs = Math.floor(Date.now() / 1000) - block.time
        return { height: info.blocks, ageSecs }
      }
    }
  } catch {}
  // Fallback: blockchair
  try {
    const r = await fetch('https://api.blockchair.com/bitcoin-sv/stats', { signal: AbortSignal.timeout(10_000) })
    if (r.ok) {
      const j = await r.json()
      const ageSecs = Math.floor(Date.now() / 1000) - j.data?.best_block_time_unix
      return { height: j.data?.blocks, ageSecs: isNaN(ageSecs) ? null : ageSecs }
    }
  } catch {}
  return null
}

// ── Analysis helpers ──────────────────────────────────────────────────────────

function fmtSats(n) {
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function fmtAge(secs) {
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s ago`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`
}

function utxoHealth(utxos) {
  const confirmed   = utxos.filter(u => u.height > 0).length
  const unconfirmed = utxos.filter(u => u.height === 0).length
  const total = utxos.length
  // Risk = if all UTXOs are unconfirmed, they're all in mempool chains
  // and could all be at depth ~20 depending on how many payments have been made
  const risk = confirmed === 0 && total > 0 ? 'HIGH' :
               confirmed < 5  && total > 0 ? 'MED'  : 'OK'
  return { confirmed, unconfirmed, total, risk }
}

function riskIcon(risk) {
  return risk === 'HIGH' ? '🔴' : risk === 'MED' ? '🟡' : '🟢'
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

async function snapshot() {
  const now = new Date().toLocaleTimeString()
  console.clear()
  console.log(`\n⚡ MESA Run Status — ${now}`)
  console.log('═'.repeat(70))

  // Block age
  const blockInfo = await fetchLastBlockAge()
  if (blockInfo) {
    const { height, ageSecs } = blockInfo
    const waitNote = ageSecs > 600 ? ` ← ⚠ overdue!` : ageSecs > 300 ? ` ← due soon` : ''
    const eta = Math.max(0, Math.round((600 - ageSecs) / 60))
    console.log(`  Last block:  #${height}  (${fmtAge(ageSecs)})${waitNote}`)
    console.log(`  Next block:  ~${eta}m away  |  depth resets at next block`)
  } else {
    console.log(`  Last block:  (WoC unavailable — rate limited or offline)`)
  }
  console.log()

  const wallets = ORCH_ONLY ? WALLETS.filter(w => w.isOrch) : WALLETS

  console.log(`  ${'WALLET'.padEnd(16)} ${'BAL'.padStart(9)}  ${'CONF'.padStart(5)}  ${'UNCONF'.padStart(6)}  ${'TOTAL'.padStart(5)}  RISK  SOURCE`)
  console.log('  ' + '─'.repeat(72))

  let orchConfirmed = 0
  let orchTotal = 0
  let anyError = false

  for (const { file, label, isOrch } of wallets) {
    const key = loadKey(file)
    if (!key) {
      console.log(`  ${label.padEnd(16)} ⚠ missing .env`)
      continue
    }
    const address = keyToAddress(key)
    let utxos = null, bal = null, errMsg = null

    try { utxos = await fetchUtxos(address) } catch (e) { errMsg = e.message }
    await sleep(350)
    if (!errMsg) {
      try { bal = await fetchBalance(address) } catch (e) { errMsg = e.message }
      await sleep(350)
    }

    if (errMsg) {
      anyError = true
      console.log(`  ${label.padEnd(16)} ⚠ ${errMsg}`)
      continue
    }

    const { confirmed, unconfirmed, total, risk } = utxoHealth(utxos)
    const totalSats = bal ? (bal.confirmed || 0) + (bal.unconfirmed || 0) : 0
    const source = bal?._source ?? 'WoC'

    if (isOrch) { orchConfirmed = confirmed; orchTotal = total }

    const riskStr = `${riskIcon(risk)} ${risk}`
    console.log(
      `  ${label.padEnd(16)} ${fmtSats(totalSats).padStart(9)}  ` +
      `${String(confirmed).padStart(5)}  ${String(unconfirmed).padStart(6)}  ` +
      `${String(total).padStart(5)}  ${riskStr.padEnd(8)}  ${source}`
    )
  }

  console.log()

  // Summary / advice
  if (orchTotal > 0) {
    if (orchConfirmed === 0) {
      console.log(`  ⚠ ORCHESTRATOR: 0 confirmed UTXOs — all ${orchTotal} are unconfirmed mempool chains.`)
      console.log(`     CHAIN_DEPTH_LIMIT active — waiting for a block will restore capacity.`)
      if (blockInfo) {
        const eta = Math.max(0, Math.round((600 - blockInfo.ageSecs) / 60))
        console.log(`     Block expected in ~${eta} min.`)
      }
    } else if (orchConfirmed < 10) {
      console.log(`  ⚠ ORCHESTRATOR: only ${orchConfirmed} confirmed UTXOs — approaching depth limit.`)
    } else {
      console.log(`  ✓ ORCHESTRATOR: ${orchConfirmed} confirmed UTXOs — healthy, payments flowing.`)
    }
  }

  if (anyError) {
    console.log(`  ℹ Some wallets hit WoC rate limits — data may be partial. Will retry next cycle.`)
    console.log(`    Tip: run with --orch flag to check just the orchestrator (fewer API calls).`)
  }

  console.log()
  if (!ONCE) {
    console.log(`  (refreshing every ${INTERVAL_MS / 1000}s — Ctrl+C to stop)`)
  }
  console.log()
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (ONCE) {
  await snapshot()
} else {
  while (true) {
    await snapshot()
    await sleep(INTERVAL_MS)
  }
}
