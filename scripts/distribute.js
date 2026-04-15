/**
 * scripts/distribute.js — Fund all 11 agent wallets from a single source wallet.
 *
 * Usage:
 *   FUNDING_KEY=<your_private_key_hex> node scripts/distribute.js
 *
 * Or put it in .env.funding:
 *   FUNDING_KEY=<hex>
 * Then run:
 *   node --env-file=.env.funding scripts/distribute.js
 *
 * How to get your private key from BSV Desktop (bsvb.tech):
 *   Settings → Security → Export Private Key (WIF or hex)
 *   If WIF format: convert with: node -e "import('@bsv/sdk').then(({PrivateKey})=>console.log(PrivateKey.fromWif('<WIF>').toHex()))"
 */
import { PrivateKey } from '@bsv/sdk'
import { BsvWallet } from '../shared/bsv.js'
import { readFileSync } from 'fs'

// ── Agent wallets to fund ────────────────────────────────────────────────────

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

const TOTAL_SATS = WALLETS.reduce((s, w) => s + w.fundSats, 0)
const BSV_PRICE  = 40

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadAgentAddress(file) {
  try {
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) {
        const hex = t.slice('AGENT_KEY='.length).trim()
        if (!hex || hex.includes('PASTE')) return null
        const priv = PrivateKey.fromHex(hex)
        return priv.toPublicKey().toAddress('mainnet').toString()
      }
    }
  } catch { }
  return null
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Get funding key — from env or first arg
  const fundingKeyRaw = process.env.FUNDING_KEY || process.argv[2]

  if (!fundingKeyRaw) {
    console.error(`
ERROR: No FUNDING_KEY provided.

Usage:
  FUNDING_KEY=<privkey_hex> node scripts/distribute.js

How to get your private key from BSV Desktop:
  1. Open BSV Desktop
  2. Go to Settings (gear icon, bottom-left)
  3. Click Security or Advanced
  4. Look for "Export Private Key" or "Show Private Key"
  5. Copy the hex (64 chars) or WIF string

If you get WIF format, convert it:
  node -e "import('@bsv/sdk').then(({PrivateKey})=>console.log(PrivateKey.fromWif('YOUR_WIF_HERE').toHex()))"
`)
    process.exit(1)
  }

  // Handle WIF format (starts with 5, K, or L)
  let fundingKeyHex = fundingKeyRaw.trim()
  if (fundingKeyHex.length !== 64) {
    try {
      const { PrivateKey: PK } = await import('@bsv/sdk')
      fundingKeyHex = PK.fromWif(fundingKeyHex).toHex()
      console.log('  (Converted WIF → hex)')
    } catch (err) {
      console.error(`ERROR: Could not parse FUNDING_KEY: ${err.message}`)
      console.error('Expected 64-char hex or WIF format.')
      process.exit(1)
    }
  }

  const wallet = new BsvWallet(fundingKeyHex)

  console.log('\n💸 MESA Distribution Script')
  console.log('═'.repeat(65))
  console.log(`  Source wallet: ${wallet.address_str}`)
  console.log(`  Total to send: ${TOTAL_SATS.toLocaleString()} sats (${(TOTAL_SATS/1e8).toFixed(4)} BSV ≈ $${(TOTAL_SATS/1e8*BSV_PRICE).toFixed(2)})`)

  // Check source balance first
  console.log('\n  Checking source balance...')
  try {
    await wallet.refreshUtxos(true)
  } catch (err) {
    console.error(`  ✗ Could not fetch UTXOs: ${err.message}`)
    process.exit(1)
  }

  const balance = wallet.balance()
  const fee_estimate = 11 * 200  // ~200 sats fee per distribution tx
  const needed = TOTAL_SATS + fee_estimate

  console.log(`  Balance:  ${balance.toLocaleString()} sats`)
  console.log(`  Needed:   ${needed.toLocaleString()} sats`)

  if (balance < needed) {
    const short = needed - balance
    console.error(`\n  ✗ INSUFFICIENT BALANCE — short by ${short.toLocaleString()} sats (${(short/1e8).toFixed(6)} BSV ≈ $${(short/1e8*BSV_PRICE).toFixed(2)})`)
    process.exit(1)
  }

  console.log(`  ✓ Balance sufficient\n`)
  console.log('─'.repeat(65))

  // Resolve all agent addresses
  const sends = []
  for (const w of WALLETS) {
    const address = loadAgentAddress(w.file)
    if (!address) {
      console.error(`  ✗ Cannot resolve address for ${w.label} (check ${w.file})`)
      process.exit(1)
    }
    sends.push({ ...w, address })
  }

  // Send to each agent wallet one at a time (to avoid UTXO races)
  let succeeded = 0
  for (const s of sends) {
    const bsv = (s.fundSats / 1e8).toFixed(4)
    process.stdout.write(`  ${s.label.padEnd(14)} ${s.address.slice(0, 20)}...  ${s.fundSats.toLocaleString()} sats... `)

    try {
      const txid = await wallet.send([{ address: s.address, satoshis: s.fundSats }])
      console.log(`✓  txid: ${txid.slice(0, 16)}...`)
      succeeded++

      // Brief pause between sends to let mempool settle
      if (succeeded < sends.length) await sleep(1_500)

    } catch (err) {
      console.log(`✗  ${err.message}`)
      console.error('\nDistribution stopped. Fix the error and re-run — already-sent wallets will be skipped by balance.js.')
      process.exit(1)
    }
  }

  console.log('─'.repeat(65))
  console.log(`\n  ✅ Distributed to ${succeeded}/${sends.length} wallets`)
  console.log('\n  Next steps:')
  console.log('    node scripts/balance.js   — verify all 11 wallets received funds')
  console.log('    node scripts/fanout.js    — split UTXOs for high-frequency use')
  console.log('    npm start                 — launch all agents\n')
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
