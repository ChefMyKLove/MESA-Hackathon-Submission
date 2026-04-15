/**
 * scripts/fanout.js — Pre-split all wallet funds into uniform 5,000-sat UTXOs.
 *
 * Why 100,000 sats:
 *   - BSV has NO dust limit — any output value is spendable
 *   - BSV has NO chain limit — can chain from one UTXO indefinitely
 *   - Larger UTXOs = fewer entries in WoC UTXO list = faster API responses
 *   - Each 100k UTXO chains ~735 bids (100000/136 sats per bid)
 *   - Labeler:      24,500,000 / 100,000 = ~245 UTXOs → 180,075 bids available
 *   - Orchestrator: 22,300,000 / 100,000 = ~223 UTXOs → 153,769 payments available
 *   - Both exceed the 138,240 needed for a 24h run
 *   - Fanout takes ~5 batches per wallet (seconds, not minutes)
 *
 * Why split ALL funds:
 *   - BsvWallet picks the LARGEST UTXO first
 *   - Uniform UTXOs mean parallel chains, not one deep chain
 *
 * All wallets fan out in parallel — total time ~3-5 minutes.
 */
import { BsvWallet } from '../shared/bsv.js'

const ENV_FILES = [
  '.env.orchestrator',
  '.env.labeler1',
  '.env.labeler2',
  '.env.labeler3',
  '.env.labeler4',
  '.env.labeler5',
  '.env.labeler6',
  '.env.labeler7',
  '.env.labeler8',
  '.env.labeler9',
  '.env.labeler10',
]

// 100,000 sats per UTXO — BSV has no dust limit so any size works.
// Larger UTXOs = fewer UTXOs = smaller WoC API responses = faster refresh.
// 100k sats chains ~735 bids each (100000/136). 245 UTXOs × 735 = 180k bids.
// That covers the full 138,240 bids needed for a 24h labeler run.
const TARGET_UTXO_SIZE = 100_000
// How many outputs per fanout transaction (BSV handles large txs fine)
const BATCH_SIZE = 50
// Minimum balance to bother fanning out
const MIN_BALANCE = 50_000

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function loadEnvFile(path) {
  try {
    const { readFileSync } = await import('fs')
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
  } catch {
    return null
  }
}

async function fanoutWallet(envFile, label) {
  const env = await loadEnvFile(envFile)
  if (!env?.AGENT_KEY) {
    console.log(`[${label}] ✗ No AGENT_KEY in ${envFile}`)
    return
  }

  const wallet = new BsvWallet(env.AGENT_KEY)
  process.stdout.write(`[${label}] ${wallet.address_str.slice(0, 22)}… fetching balance… `)

  try {
    await wallet.refreshUtxos(true)
  } catch (err) {
    console.log(`✗ WoC error: ${err.message}`)
    return
  }

  const balance = wallet.balance()

  if (balance < MIN_BALANCE) {
    console.log(`✗ UNDERFUNDED (${balance} sats — need ≥ ${MIN_BALANCE})`)
    return
  }

  // How many UTXOs should we create?
  // Leave ~5,000 sats for fees on the fanout txs themselves
  const spendable     = balance - 5_000
  const targetCount   = Math.floor(spendable / TARGET_UTXO_SIZE)
  const existingSmall = wallet._utxos.filter(u => u.satoshis <= TARGET_UTXO_SIZE * 1.1).length

  if (existingSmall >= targetCount * 0.95) {
    console.log(`✓ Already fanned out (${existingSmall} UTXOs @ ~${TARGET_UTXO_SIZE} sats)`)
    return
  }

  console.log(`${balance.toLocaleString()} sats → splitting into ~${targetCount} × ${TARGET_UTXO_SIZE}-sat UTXOs`)

  let created = 0
  const needed = targetCount - existingSmall

  while (created < needed) {
    const batchCount = Math.min(BATCH_SIZE, needed - created)
    const outputs = Array.from({ length: batchCount }, () => ({
      address:  wallet.address_str,
      satoshis: TARGET_UTXO_SIZE,
    }))

    try {
      const txid = await wallet.send(outputs)
      created += batchCount
      const pct = Math.round(created / needed * 100)
      process.stdout.write(`\r[${label}] ${pct}% (${created}/${needed} UTXOs created, txid ${txid.slice(0, 12)}…)  `)

      // Brief pause then refresh so next batch has up-to-date UTXO pool
      await sleep(1_500)
      await wallet.refreshUtxos(true)
    } catch (err) {
      console.log(`\n[${label}] ✗ Batch failed: ${err.message}`)
      break
    }
  }

  console.log(`\n[${label}] ✅ Done — ${wallet._utxos.length} UTXOs in pool`)
}

async function main() {
  console.log('\n🔀 MESA UTXO Fanout')
  console.log('═'.repeat(60))
  console.log(`Target: ${TARGET_UTXO_SIZE} sats/UTXO | ${BATCH_SIZE} outputs/tx | all wallets parallel\n`)

  // Run wallets sequentially — parallel hits WoC rate limits (429)
  for (const f of ENV_FILES) {
    await fanoutWallet(f, f.replace('.env.', ''))
    await sleep(2_000)  // brief pause between wallets
  }

  console.log('\n' + '═'.repeat(60))
  console.log('✅ Fanout complete.')
  console.log('\nNext steps:')
  console.log('  node scripts/balance.js   — verify all wallets')
  console.log('  npm run test-run          — 2-minute test')
  console.log('  npm start                 — full 24h run\n')
}

main().catch(console.error)
