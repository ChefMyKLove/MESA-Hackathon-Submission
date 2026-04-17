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
      // Use WoC /balance endpoint — returns true confirmed total regardless of UTXO count.
      // The /unspent endpoint caps at 1000 results (oldest-first), so addresses with many
      // dust UTXOs (e.g. orchestrator after labeler bid accumulation) report wrong balances.
      const balResp = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${wallet.address_str}/balance`)
      let bal = 0
      let utxoNote = ''
      if (balResp.ok) {
        const { confirmed, unconfirmed } = await balResp.json()
        bal = confirmed + (unconfirmed || 0)
        utxoNote = unconfirmed ? ` (+${unconfirmed} unconf)` : ''
      } else {
        // Fallback to local UTXO pool
        await wallet.refreshUtxos(true)
        bal = wallet.balance()
        utxoNote = ` (${wallet._utxos.length} UTXOs)`
      }
      totalSats += bal
      const flag  = bal < 1_000_000 ? ' ⚠ LOW' : bal < 5_000_000 ? ' ⚡ OK' : ' ✓'
      console.log(
        `  ${label.padEnd(12)}  ${String(bal).padStart(12)} sats${utxoNote}${flag}`)
      console.log(`  ${''.padEnd(12)}  ${wallet.address_str}`)
    } catch (err) {
      console.log(`  ${label.padEnd(12)}  ⚠ fetch failed: ${err.message}`)
    }
  }

  console.log('─'.repeat(55))
  console.log(`  ${'TOTAL'.padEnd(12)}  ${String(totalSats).padStart(8)} sats  (${(totalSats / 1e8).toFixed(6)} BSV)\n`)

  // 1.5M tx = 138,240 task cycles (1.6/sec × 86,400s)
  // Each cycle:
  //   10 bid txs:    ~44 sats fee each (zero-output: OP_RETURN + change only)
  //   1 inscription: ~44 sats fee
  //   1 payment tx:  ~52 sats fee + 10 sats reward = 62 sats
  // Total per cycle: 10×44 + 44 + 62 = 546 sats
  const needed24h = 138_240 * 546
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
