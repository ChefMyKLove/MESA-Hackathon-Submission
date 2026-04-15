/**
 * scripts/topup.js — Top up any under-funded agent wallets from healthy ones.
 *
 * Targets:
 *   orchestrator  → needs ~2M sats minimum; sources from labeler-1
 *   labeler-2     → topped up from labeler-3 if below threshold
 *   labeler-4     → topped up from labeler-5 if below threshold
 *
 * Usage:
 *   node scripts/topup.js
 */
import { BsvWallet } from '../shared/bsv.js'
import { readFileSync } from 'fs'

function loadKey(envFile) {
  const content = readFileSync(envFile, 'utf8')
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (t.startsWith('AGENT_KEY=')) return t.slice('AGENT_KEY='.length).trim()
  }
  throw new Error(`No AGENT_KEY in ${envFile}`)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Top-up jobs: { from, to, threshold, sendAmount }
// If 'to' wallet is below threshold, send sendAmount from 'from' wallet.
const JOBS = [
  {
    // labeler-7 (74M+) keeps labeler-1 healthy so it can always fund orchestrator
    fromFile:  '.env.labeler7',
    toFile:    '.env.labeler1',
    fromLabel: 'labeler-7',
    toLabel:   'labeler-1',
    threshold:  5_000_000,   // top up if labeler-1 < 5M sats
    sendAmount: 10_000_000,  // send 10M sats
  },
  {
    // labeler-1 funds orchestrator — send 3M so it works even when labeler-1 is low
    fromFile:  '.env.labeler1',
    toFile:    '.env.orchestrator',
    fromLabel: 'labeler-1',
    toLabel:   'orchestrator',
    threshold:  2_000_000,   // top up if orch < 2M sats
    sendAmount: 3_000_000,   // send 3M sats (safe even when labeler-1 has 4M)
  },
  {
    fromFile:  '.env.labeler3',
    toFile:    '.env.labeler2',
    fromLabel: 'labeler-3',
    toLabel:   'labeler-2',
    threshold:  5_000_000,   // top up if labeler-2 < 5M sats
    sendAmount: 12_000_000,  // send 12M sats
  },
  {
    fromFile:  '.env.labeler5',
    toFile:    '.env.labeler4',
    fromLabel: 'labeler-5',
    toLabel:   'labeler-4',
    threshold:  5_000_000,   // top up if labeler-4 < 5M sats
    sendAmount: 12_000_000,  // send 12M sats
  },
]

async function main() {
  console.log('\n🔧 MESA Wallet Top-up')
  console.log('═'.repeat(60))

  let anyAction = false

  for (const job of JOBS) {
    const toWallet = new BsvWallet(loadKey(job.toFile))
    await toWallet.refreshUtxos(true)
    const toBal = toWallet.balance()

    process.stdout.write(`  ${job.toLabel.padEnd(14)} ${toBal.toLocaleString().padStart(12)} sats  `)

    if (toBal >= job.threshold) {
      console.log(`✓  (above ${job.threshold.toLocaleString()} threshold)`)
      continue
    }

    // Need to top up
    const fromWallet = new BsvWallet(loadKey(job.fromFile))
    await fromWallet.refreshUtxos(true)
    const fromBal = fromWallet.balance()

    if (fromBal < job.sendAmount + 50_000) {
      console.log(`⚠  LOW — but ${job.fromLabel} only has ${fromBal.toLocaleString()} sats, skipping`)
      continue
    }

    process.stdout.write(`⚠  LOW → sending ${job.sendAmount.toLocaleString()} from ${job.fromLabel}... `)
    try {
      const txid = await fromWallet.send([{ address: toWallet.address_str, satoshis: job.sendAmount }])
      console.log(`✓  ${txid.slice(0, 16)}...`)
      anyAction = true
      await sleep(1_500)
    } catch (err) {
      console.log(`✗  ${err.message}`)
    }
  }

  console.log('─'.repeat(60))
  if (anyAction) {
    console.log('\n  ✅ Top-up complete. Run balance.js to verify.\n')
  } else {
    console.log('\n  ✅ All wallets above thresholds — no top-up needed.\n')
  }
}

main().catch(console.error)
