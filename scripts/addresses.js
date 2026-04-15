/**
 * scripts/addresses.js — Print every agent's BSV address and funding target.
 * Derives addresses locally from private keys — no network call needed.
 *
 * Run: node scripts/addresses.js
 */
import { PrivateKey } from '@bsv/sdk'
import { readFileSync } from 'fs'

const WALLETS = [
  { file: '.env.orchestrator', label: 'orchestrator', fundSats: 22_300_000 },
  { file: '.env.labeler1',     label: 'labeler-1',    fundSats: 24_500_000 },
  { file: '.env.labeler2',     label: 'labeler-2',    fundSats: 24_500_000 },
  { file: '.env.labeler3',     label: 'labeler-3',    fundSats: 24_500_000 },
  { file: '.env.labeler4',     label: 'labeler-4',    fundSats: 24_500_000 },
  { file: '.env.labeler5',     label: 'labeler-5',    fundSats: 24_500_000 },
  { file: '.env.labeler6',     label: 'labeler-6',    fundSats: 24_500_000 },
  { file: '.env.labeler7',     label: 'labeler-7',    fundSats: 24_500_000 },
  { file: '.env.labeler8',     label: 'labeler-8',    fundSats: 24_500_000 },
  { file: '.env.labeler9',     label: 'labeler-9',    fundSats: 24_500_000 },
  { file: '.env.labeler10',    label: 'labeler-10',   fundSats: 24_500_000 },
]

const BSV_PRICE_USD = 40  // update this to current BSV price before funding

function loadKey(file) {
  try {
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) return t.slice('AGENT_KEY='.length).trim()
    }
  } catch { }
  return null
}

function deriveAddress(privKeyHex) {
  const priv = PrivateKey.fromHex(privKeyHex)
  return priv.toPublicKey().toAddress('mainnet').toString()
}

let totalSats = 0
let totalBsv  = 0

console.log('\n💰 MESA Wallet Funding Guide')
console.log('═'.repeat(72))
console.log(`  BSV price used: $${BSV_PRICE_USD}`)
console.log('─'.repeat(72))

for (const w of WALLETS) {
  const keyHex = loadKey(w.file)
  if (!keyHex || keyHex.includes('PASTE')) {
    console.log(`\n  ${w.label.padEnd(14)} ⚠ AGENT_KEY not set in ${w.file}`)
    continue
  }

  let address
  try {
    address = deriveAddress(keyHex)
  } catch (err) {
    console.log(`\n  ${w.label.padEnd(14)} ⚠ Could not derive address: ${err.message}`)
    continue
  }

  const bsv  = w.fundSats / 1e8
  const usd  = bsv * BSV_PRICE_USD
  totalSats += w.fundSats
  totalBsv  += bsv

  console.log(`\n  ${w.label.padEnd(14)} ${String(w.fundSats).padStart(11)} sats  (${bsv.toFixed(4)} BSV ≈ $${usd.toFixed(2)})`)
  console.log(`  ${''.padEnd(14)} ${address}`)
}

const totalUsd = totalBsv * BSV_PRICE_USD
console.log('\n' + '─'.repeat(72))
console.log(`  ${'TOTAL'.padEnd(14)} ${String(totalSats).padStart(11)} sats  (${totalBsv.toFixed(4)} BSV ≈ $${totalUsd.toFixed(2)})`)
console.log('═'.repeat(72))

console.log(`
📋 Funding checklist:
  1. Open BSV Desktop
  2. For each address above, send the listed amount in one transaction
  3. Wait for confirmations (usually <1 min on BSV)
  4. Run: node scripts/balance.js   — to verify all wallets received funds
  5. Run: node scripts/fanout.js    — to split UTXOs for high-frequency use
  6. Run: npm start                 — to launch all agents
`)
