/**
 * scripts/fund-new-wallets.js — Fund the new agent wallets from the old orchestrator.
 *
 * Amounts are sized for a full 24h run + 15% buffer.
 *
 * Usage:
 *   FUNDING_KEY=<old_orchestrator_private_key_hex> node scripts/fund-new-wallets.js
 *
 * Or put it in .env.funding:
 *   FUNDING_KEY=a02a7a95b0bf005227909d68e7ae65febdb6b57c4621e558593f2f8c0e95e1af
 * Then:
 *   node --env-file=.env.funding scripts/fund-new-wallets.js
 */
import { PrivateKey } from '@bsv/sdk'
import { BsvWallet } from '../shared/bsv.js'
import { readFileSync } from 'fs'

const BUFFER = 1.15  // 15% headroom

// Base 24h run amounts (sats) — matches distribute.js proven amounts
const BASE_ORCHESTRATOR_SATS = 22_300_000
const BASE_LABELER_SATS      = 24_500_000

const WALLETS = [
  { file: '.env.orchestrator', label: 'NEXUS (orch)',  fundSats: Math.ceil(BASE_ORCHESTRATOR_SATS * BUFFER) },
  { file: '.env.labeler1',     label: 'ARIA  (L1)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler2',     label: 'BOLT  (L2)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler3',     label: 'CIPHER(L3)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler4',     label: 'DELTA (L4)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler5',     label: 'ECHO  (L5)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler6',     label: 'FLUX  (L6)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler7',     label: 'GRAPH (L7)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler8',     label: 'HELIX (L8)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler9',     label: 'IRIS  (L9)',    fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
  { file: '.env.labeler10',    label: 'JADE  (L10)',   fundSats: Math.ceil(BASE_LABELER_SATS * BUFFER) },
]

const TOTAL_SATS = WALLETS.reduce((s, w) => s + w.fundSats, 0)
const BSV_PRICE  = 40

function loadAgentAddress(file) {
  try {
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) {
        const hex = t.slice('AGENT_KEY='.length).trim()
        if (!hex || hex.includes('PASTE') || hex.length !== 64) return null
        return PrivateKey.fromHex(hex).toPublicKey().toAddress('mainnet').toString()
      }
    }
  } catch { }
  return null
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const fundingKeyRaw = process.env.FUNDING_KEY || process.argv[2]

  if (!fundingKeyRaw) {
    console.error(`
ERROR: No FUNDING_KEY provided.

Usage:
  FUNDING_KEY=<old_orchestrator_privkey_hex> node scripts/fund-new-wallets.js

The old orchestrator key is the one that was previously in .env.orchestrator.
`)
    process.exit(1)
  }

  let fundingKeyHex = fundingKeyRaw.trim()
  if (fundingKeyHex.length !== 64) {
    try {
      const { PrivateKey: PK } = await import('@bsv/sdk')
      fundingKeyHex = PK.fromWif(fundingKeyHex).toHex()
      console.log('  (Converted WIF → hex)')
    } catch (err) {
      console.error(`ERROR: Could not parse FUNDING_KEY: ${err.message}`)
      process.exit(1)
    }
  }

  const sourceWallet = new BsvWallet(fundingKeyHex)

  console.log('\n💸 MESA New-Wallet Funding Script')
  console.log('═'.repeat(65))
  console.log(`  Source:        ${sourceWallet.address_str}`)
  console.log(`  Buffer:        +${Math.round((BUFFER - 1) * 100)}%`)
  console.log(`  Per labeler:   ${Math.ceil(BASE_LABELER_SATS * BUFFER).toLocaleString()} sats  (base ${BASE_LABELER_SATS.toLocaleString()} + 15%)`)
  console.log(`  Orchestrator:  ${Math.ceil(BASE_ORCHESTRATOR_SATS * BUFFER).toLocaleString()} sats  (base ${BASE_ORCHESTRATOR_SATS.toLocaleString()} + 15%)`)
  console.log(`  Total needed:  ${TOTAL_SATS.toLocaleString()} sats  (${(TOTAL_SATS / 1e8).toFixed(4)} BSV ≈ $${(TOTAL_SATS / 1e8 * BSV_PRICE).toFixed(2)})`)

  console.log('\n  Checking source balance...')
  await sourceWallet.refreshUtxos(true)
  // Recover large UTXOs hidden behind dust on WoC's capped /unspent endpoint
  await sourceWallet._mergeGorillaPoolUtxos()

  // Use WoC /balance for accurate confirmed total (not affected by UTXO cap)
  let balance = sourceWallet.balance()
  try {
    const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${sourceWallet.address_str}/balance`)
    if (r.ok) {
      const { confirmed, unconfirmed } = await r.json()
      balance = (confirmed || 0) + (unconfirmed || 0)
    }
  } catch { /* fall back to local pool count */ }

  const feeEstimate = WALLETS.length * 200
  const needed      = TOTAL_SATS + feeEstimate

  console.log(`  Balance:       ${balance.toLocaleString()} sats  (${(balance / 1e8).toFixed(4)} BSV)`)
  console.log(`  UTXOs loaded:  ${sourceWallet._utxos.length} (after GorillaPool merge)`)
  console.log(`  Needed:        ${needed.toLocaleString()} sats`)

  if (balance < needed) {
    const short = needed - balance
    console.error(`\n  ✗ INSUFFICIENT BALANCE`)
    console.error(`    Short by ${short.toLocaleString()} sats (${(short / 1e8).toFixed(6)} BSV ≈ $${(short / 1e8 * BSV_PRICE).toFixed(2)})`)
    console.error(`    Top up ${sourceWallet.address_str} and re-run.`)
    process.exit(1)
  }

  console.log(`  ✓ Balance sufficient\n`)
  console.log('─'.repeat(65))

  // Resolve all destination addresses
  const sends = []
  for (const w of WALLETS) {
    const address = loadAgentAddress(w.file)
    if (!address) {
      console.error(`  ✗ Cannot resolve address for ${w.label} — check ${w.file}`)
      process.exit(1)
    }
    sends.push({ ...w, address })
    console.log(`  ${w.label.padEnd(14)} → ${address}`)
  }

  console.log('\n' + '─'.repeat(65))
  console.log('  Sending...\n')

  let succeeded = 0
  for (const s of sends) {
    process.stdout.write(`  ${s.label.padEnd(14)} ${s.fundSats.toLocaleString().padStart(12)} sats... `)
    try {
      const txid = await sourceWallet.send([{ address: s.address, satoshis: s.fundSats }])
      console.log(`✓  ${txid.slice(0, 20)}...`)
      succeeded++
      if (succeeded < sends.length) await sleep(1_500)
    } catch (err) {
      console.log(`✗  ${err.message}`)
      console.error('\nStopped. Re-run to retry — funded wallets will just receive extra.')
      process.exit(1)
    }
  }

  console.log('\n' + '─'.repeat(65))
  console.log(`\n  ✅ Funded ${succeeded}/${sends.length} wallets`)
  console.log('\n  Next steps:')
  console.log('    node scripts/balance.js   — confirm all 11 wallets received funds')
  console.log('    node scripts/fanout.js    — split UTXOs for high-frequency use')
  console.log('    npm start                 — launch full 24h run\n')
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
