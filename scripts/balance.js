/**
 * scripts/balance.js — Check wallet balances for all agents.
 * Run: node scripts/balance.js
 */
import { BsvWallet } from '../shared/bsv.js'
import { readFileSync } from 'fs'

const ENV_FILES = [
  ['.env.orchestrator', 'orchestrator'],
  ['.env.labeler1',  'labeler-1'],
  ['.env.labeler2',  'labeler-2'],
  ['.env.labeler3',  'labeler-3'],
  ['.env.labeler4',  'labeler-4'],
  ['.env.labeler5',  'labeler-5'],
  ['.env.labeler6',  'labeler-6'],
  ['.env.labeler7',  'labeler-7'],
  ['.env.labeler8',  'labeler-8'],
  ['.env.labeler9',  'labeler-9'],
  ['.env.labeler10', 'labeler-10'],
]

function loadEnv(path) {
  try {
    const content = readFileSync(path, 'utf8')
    const env = {}
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    return env
  } catch { return null }
}

async function main() {
  console.log('\n💰 MESA Wallet Balances\n' + '─'.repeat(55))

  let totalSats = 0

  for (const [file, label] of ENV_FILES) {
    const env = loadEnv(file)
    if (!env?.AGENT_KEY) {
      console.log(`  ${label.padEnd(12)} — env file not found or missing AGENT_KEY`)
      continue
    }

    const wallet = new BsvWallet(env.AGENT_KEY)
    try {
      await wallet.refreshUtxos(true)
      const bal   = wallet.balance()
      const utxos = wallet._utxos.length
      totalSats  += bal
      const flag  = bal < 1_000_000 ? ' ⚠ LOW' : bal < 5_000_000 ? ' ⚡ OK' : ' ✓'
      console.log(
        `  ${label.padEnd(12)}  ${String(bal).padStart(8)} sats  (${utxos} UTXOs)${flag}`)
      console.log(`  ${''.padEnd(12)}  ${wallet.address_str}`)
    } catch (err) {
      console.log(`  ${label.padEnd(12)}  ⚠ fetch failed: ${err.message}`)
    }
  }

  console.log('─'.repeat(55))
  console.log(`  ${'TOTAL'.padEnd(12)}  ${String(totalSats).padStart(8)} sats  (${(totalSats / 1e8).toFixed(6)} BSV)\n`)

  // 1.5M tx = 125,000 task cycles
  // Each cycle: 10 bid txs (135 sat fee each) + 1 inscription (135) + 1 payment (135)
  // = 12 txs × 135 sats fee = 1,620 sats in fees per cycle
  // Plus 10 sats in bid deposits + 10 sats reward = 20 sats economic value
  // Total per cycle: 1,640 sats
  const needed24h = 125_000 * 1_640
  console.log(`  Estimated sats needed for 1.5M tx (125k cycles × 1,640 sats): ${needed24h.toLocaleString()} sats`)
  console.log(`  Current total: ${totalSats.toLocaleString()} sats`)
  if (totalSats < needed24h) {
    const deficit = needed24h - totalSats
    console.log(`  ⚠ SHORT by ${deficit.toLocaleString()} sats (${(deficit / 1e8).toFixed(6)} BSV ≈ $${(deficit / 1e8 * 40).toFixed(2)})`)
  } else {
    console.log(`  ✓ Sufficient balance for full 24h run`)
  }
  console.log()
}

main().catch(console.error)
