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
 * APIs tried in order per wallet: WoC → Bitails → Blockchair
 * On 429, immediately moves to next API (no retry loop).
 * Caches last-known data and shows it as "(stale)" when all APIs fail.
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const BITAILS  = 'https://api.bitails.io'
const BLOCKCHAIR = 'https://api.blockchair.com/bitcoin-sv'
const sleep    = ms => new Promise(r => setTimeout(r, ms))
const ONCE     = process.argv.includes('--once')
const ORCH_ONLY = process.argv.includes('--orch')
const INTERVAL_MS = 60_000   // 60s between full refreshes (reduces rate-limit pressure)

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

// ── Multi-API fetch with caching ──────────────────────────────────────────────

// address → { utxos, bal, source, ts }
const dataCache = new Map()

async function quickFetch(url, ms = 10_000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) })
  if (r.status === 429) { const e = new Error('429'); e.is429 = true; throw e }
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// Normalize any UTXO array into [{height, value}]
function normalizeUtxos(raw) {
  const arr = Array.isArray(raw) ? raw : (raw?.utxos ?? raw?.data ?? [])
  return arr.map(u => ({
    height: u.height ?? u.block_height ?? (u.confirmations > 0 ? 1 : 0),
    value:  u.value  ?? u.satoshis ?? 0,
  }))
}

async function fetchWalletData(address) {
  // ── 1. WoC ──────────────────────────────────────────────────────────────────
  try {
    const [utxosRaw, bal] = await Promise.all([
      quickFetch(`${WOC}/address/${address}/unspent`),
      quickFetch(`${WOC}/address/${address}/balance`),
    ])
    const result = { utxos: normalizeUtxos(utxosRaw), bal, source: 'WoC', ts: Date.now() }
    dataCache.set(address, result)
    return result
  } catch (e) {
    if (!e.is429 && !e.message.startsWith('HTTP')) throw e
    // 429 or server error — fall through to next API
  }

  await sleep(200)

  // ── 2. Bitails ───────────────────────────────────────────────────────────────
  try {
    const [utxosRaw, bal] = await Promise.all([
      quickFetch(`${BITAILS}/address/${address}/unspent`),
      quickFetch(`${BITAILS}/address/${address}/balance`),
    ])
    const result = { utxos: normalizeUtxos(utxosRaw), bal, source: 'Bitails', ts: Date.now() }
    dataCache.set(address, result)
    return result
  } catch {}

  await sleep(200)

  // ── 3. Blockchair (balance only — no UTXO depth info) ───────────────────────
  try {
    const j = await quickFetch(`${BLOCKCHAIR}/addresses/balances?addresses=${address}`)
    const sats = j?.data?.[address] ?? 0
    const result = {
      utxos: null,   // no UTXO detail from Blockchair
      bal: { confirmed: sats, unconfirmed: 0 },
      source: 'Blockchair',
      ts: Date.now(),
    }
    dataCache.set(address, result)
    return result
  } catch {}

  // ── 4. Return cached data (show as stale) ────────────────────────────────────
  const cached = dataCache.get(address)
  if (cached) return { ...cached, stale: true }

  return null   // no data at all
}

// ── Block age ─────────────────────────────────────────────────────────────────

async function fetchLastBlockAge() {
  // WoC
  try {
    const info = await quickFetch(`${WOC}/chain/info`)
    const block = await quickFetch(`${WOC}/block/hash/${info.bestblockhash}`)
    return { height: info.blocks, ageSecs: Math.floor(Date.now() / 1000) - block.time, source: 'WoC' }
  } catch {}
  // Blockchair
  try {
    const j = await quickFetch(`${BLOCKCHAIR}/stats`)
    const ageSecs = Math.floor(Date.now() / 1000) - j.data?.best_block_time_unix
    if (!isNaN(ageSecs)) return { height: j.data?.blocks, ageSecs, source: 'Blockchair' }
  } catch {}
  return null
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtSats(n) {
  if (n >= 1e8)  return (n / 1e8).toFixed(3) + ' BSV'
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function fmtAge(secs) {
  if (secs < 60)   return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s ago`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m ago`
}

function fmtStale(ts) {
  const m = Math.round((Date.now() - ts) / 60_000)
  return m < 1 ? '(stale <1m)' : `(stale ${m}m)`
}

function utxoHealth(utxos) {
  if (!utxos) return { confirmed: '?', unconfirmed: '?', total: '?', risk: 'UNKN' }
  const confirmed   = utxos.filter(u => u.height > 0).length
  const unconfirmed = utxos.filter(u => u.height === 0).length
  const total = utxos.length
  const risk = confirmed === 0 && total > 0 ? 'HIGH' :
               confirmed < 5  && total > 0 ? 'MED'  : 'OK'
  return { confirmed, unconfirmed, total, risk }
}

function riskIcon(risk) {
  return risk === 'HIGH' ? '🔴' : risk === 'MED' ? '🟡' : risk === 'OK' ? '🟢' : '⚪'
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

async function snapshot() {
  const now = new Date().toLocaleTimeString()
  console.clear()
  console.log(`\n⚡ MESA Run Status — ${now}`)
  console.log('═'.repeat(70))

  const blockInfo = await fetchLastBlockAge()
  if (blockInfo) {
    const { height, ageSecs, source } = blockInfo
    const warn = ageSecs > 600 ? ' ← ⚠ overdue!' : ageSecs > 300 ? ' ← due soon' : ''
    const eta  = Math.max(0, Math.round((600 - ageSecs) / 60))
    console.log(`  Block #${height}  ${fmtAge(ageSecs)}${warn}   (~${eta}m to next)   [${source}]`)
  } else {
    console.log(`  Last block: (all APIs unavailable)`)
  }
  console.log()

  const wallets = ORCH_ONLY ? WALLETS.filter(w => w.isOrch) : WALLETS

  console.log(`  ${'WALLET'.padEnd(16)} ${'BALANCE'.padStart(10)}  ${'CONF'.padStart(5)}  ${'UNCONF'.padStart(6)}  ${'TOTAL'.padStart(5)}  RISK  SOURCE`)
  console.log('  ' + '─'.repeat(74))

  let orchConfirmed = 0, orchTotal = 0

  for (const { file, label, isOrch } of wallets) {
    const key = loadKey(file)
    if (!key) { console.log(`  ${label.padEnd(16)} ⚠ missing .env`); continue }

    const address = keyToAddress(key)
    const data = await fetchWalletData(address)
    await sleep(500)   // pace requests

    if (!data) {
      console.log(`  ${label.padEnd(16)} ✗ all APIs failed — no cached data`)
      continue
    }

    const { utxos, bal, source, stale, ts } = data
    const { confirmed, unconfirmed, total, risk } = utxoHealth(utxos)
    const totalSats = bal ? (bal.confirmed || 0) + (bal.unconfirmed || 0) : 0
    const staleTag  = stale ? ` ${fmtStale(ts)}` : ''
    const srcLabel  = `${source}${staleTag}`

    if (isOrch && typeof confirmed === 'number') { orchConfirmed = confirmed; orchTotal = total }

    const riskStr = `${riskIcon(risk)} ${risk}`
    console.log(
      `  ${label.padEnd(16)} ${fmtSats(totalSats).padStart(10)}  ` +
      `${String(confirmed).padStart(5)}  ${String(unconfirmed).padStart(6)}  ` +
      `${String(total).padStart(5)}  ${riskStr.padEnd(8)}  ${srcLabel}`
    )
  }

  console.log()

  if (orchTotal !== 0) {
    if (orchConfirmed === 0) {
      console.log(`  ⚠ ORCHESTRATOR: 0 confirmed UTXOs — all ${orchTotal} unconfirmed (depth limit risk).`)
      if (blockInfo) console.log(`     Next block in ~${Math.max(0, Math.round((600 - blockInfo.ageSecs) / 60))}m will reset depth.`)
    } else if (orchConfirmed < 10) {
      console.log(`  ⚠ ORCHESTRATOR: only ${orchConfirmed} confirmed UTXOs — approaching limit.`)
    } else {
      console.log(`  ✓ ORCHESTRATOR: ${orchConfirmed} confirmed / ${orchTotal} total UTXOs — healthy.`)
    }
  }

  console.log()
  if (!ONCE) console.log(`  (refreshing every ${INTERVAL_MS / 1000}s — Ctrl+C to stop)`)
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

