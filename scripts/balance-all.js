/**
 * scripts/balance-all.js — Check every wallet ever created in this project.
 *
 * Covers: current .env files + all previous/old keys hardcoded below.
 * Uses WoC /balance endpoint (correct even for addresses with 100k+ dust UTXOs).
 *
 * Usage: node scripts/balance-all.js
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'

const WOC   = 'https://api.whatsonchain.com/v1/bsv/main'
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Current wallets (read from .env files) ───────────────────────────────────

const CURRENT_ENV = [
  { file: '.env.orchestrator', label: 'NEXUS (orch)' },
  { file: '.env.labeler1',     label: 'ARIA  (L1)'   },
  { file: '.env.labeler2',     label: 'BOLT  (L2)'   },
  { file: '.env.labeler3',     label: 'CIPHER(L3)'   },
  { file: '.env.labeler4',     label: 'DELTA (L4)'   },
  { file: '.env.labeler5',     label: 'ECHO  (L5)'   },
  { file: '.env.labeler6',     label: 'FLUX  (L6)'   },
  { file: '.env.labeler7',     label: 'GRAPH (L7)'   },
  { file: '.env.labeler8',     label: 'HELIX (L8)'   },
  { file: '.env.labeler9',     label: 'IRIS  (L9)'   },
  { file: '.env.labeler10',    label: 'JADE  (L10)'  },
]

// ── Old / previous wallets (hardcoded — no longer in .env files) ─────────────

const OLD_WALLETS = [
  // Generation 2 (ran last test-run, session handoff balances)
  { key: 'a02a7a95b0bf005227909d68e7ae65febdb6b57c4621e558593f2f8c0e95e1af', label: 'prev-orch (gen2)' },
  { key: '98e68af864aca7b3307abe1a0fc135f12687a2368cf216cfcac0af9913643503', label: 'prev-L1   (gen2)' },
  { key: '7d29b0a3079659c9933e590d7e6253f62ad61ebea78e073c70930b7ed43e9eb2', label: 'prev-L2   (gen2)' },
  { key: '4ccab8efa2ba36ec0d23db75563c7c14127d2f5015879efd5e2b07ba81e1c762', label: 'prev-L3   (gen2)' },
  { key: 'f2d03b4eed91476e49aee5255a96e9e8db0e508d6141ec6fa60904875482a9e2', label: 'prev-L4   (gen2)' },
  { key: 'c3abbf385b20a9027d368ccedc8b507338ed9d9f4a73e109d71919d56bd6358a', label: 'prev-L5   (gen2)' },
  { key: 'a38efb923cc3f7b22da3b93d8563a3dddadfa41b59e76031c646a7209adf63b4', label: 'prev-L6   (gen2)' },
  { key: 'edb245cac0ac32a8ae07b8e1efc487f0614262907b8d9066455cb95906e58b36', label: 'prev-L7   (gen2)' },
  { key: '80be8ac5e96ed7414bf2fe5b206511e23f87b6613484de22f334b9a7534517d8', label: 'prev-L8   (gen2)' },
  { key: 'f135c4c3a274b25e45186a3517d51bbe510f6d09042b6f88719381165bb3ba64', label: 'prev-L9   (gen2)' },
  { key: 'f98954cf2628d0fd3814af7637ac9d8761f45853140cb7b8eb994d85a1d0d61e', label: 'prev-L10  (gen2)' },
  // Generation 1 (original orchestrator — 18xNrXZ...)
  { key: '9b080c6221282881e08d631fe9c225360b32db6dadc0f917ecf760f39a15b746', label: 'old-orch  (gen1)' },
]

// ── Helpers ──────────────────────────────────────────────────────────────────

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

async function getBalance(address) {
  const [balResp, unspentResp] = await Promise.all([
    fetch(`${WOC}/address/${address}/balance`,  { signal: AbortSignal.timeout(15_000) }),
    fetch(`${WOC}/address/${address}/unspent`,  { signal: AbortSignal.timeout(15_000) }),
  ])
  if (!balResp.ok) throw new Error(`WoC ${balResp.status}`)
  const { confirmed, unconfirmed } = await balResp.json()
  let utxoCount = '?'
  if (unspentResp.ok) {
    const utxos = await unspentResp.json()
    utxoCount = Array.isArray(utxos) ? utxos.length : '?'
  }
  return { confirmed: confirmed || 0, unconfirmed: unconfirmed || 0, utxoCount }
}

function fmt(sats) { return sats.toLocaleString().padStart(14) }
function flag(sats) {
  if (sats === 0)          return '  —'
  if (sats < 1_000_000)   return '  ⚠ LOW'
  if (sats < 10_000_000)  return '  ⚡'
  return '  ✓'
}

async function printRow(label, address) {
  try {
    const { confirmed, unconfirmed, utxoCount } = await getBalance(address)
    const total = confirmed + unconfirmed
    const unconfNote = unconfirmed ? ` (+${unconfirmed.toLocaleString()} unconf)` : ''
    const utxoNote = ` | ${utxoCount} UTXOs`
    console.log(`  ${label.padEnd(18)} ${fmt(confirmed)} sats${unconfNote}${utxoNote}${flag(total)}`)
    console.log(`  ${''.padEnd(18)} ${address}`)
    await sleep(350)  // avoid WoC 429
    return total
  } catch (err) {
    console.log(`  ${label.padEnd(18)} ⚠ fetch error: ${err.message}`)
    await sleep(1000)
    return 0
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n💰 MESA — All Wallet Balances\n')

  // ── Current wallets
  console.log('CURRENT WALLETS (active .env files)')
  console.log('─'.repeat(65))
  let currentTotal = 0
  for (const { file, label } of CURRENT_ENV) {
    const key = loadKey(file)
    if (!key) { console.log(`  ${label.padEnd(18)} ⚠ ${file} missing or no AGENT_KEY`); continue }
    currentTotal += await printRow(label, keyToAddress(key))
  }
  console.log('─'.repeat(65))
  console.log(`  ${'CURRENT TOTAL'.padEnd(18)} ${fmt(currentTotal)} sats  (${(currentTotal / 1e8).toFixed(4)} BSV)\n`)

  // ── Old wallets
  console.log('OLD WALLETS (previous generations)')
  console.log('─'.repeat(65))
  let oldTotal = 0
  for (const { key, label } of OLD_WALLETS) {
    oldTotal += await printRow(label, keyToAddress(key))
  }
  console.log('─'.repeat(65))
  console.log(`  ${'OLD TOTAL'.padEnd(18)} ${fmt(oldTotal)} sats  (${(oldTotal / 1e8).toFixed(4)} BSV)\n`)

  // ── Grand total
  const grand = currentTotal + oldTotal
  console.log('═'.repeat(65))
  console.log(`  ${'GRAND TOTAL'.padEnd(18)} ${fmt(grand)} sats  (${(grand / 1e8).toFixed(4)} BSV)`)
  console.log('═'.repeat(65))
  console.log()
}

main().catch(console.error)
