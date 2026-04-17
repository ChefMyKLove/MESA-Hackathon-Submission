/**
 * scripts/rebalance-labelers.js
 * Tops up low labelers from rich ones so every labeler has enough for 24h.
 *
 * Target per labeler: 10,000,000 sats (0.1 BSV) — covers 24h at current burn rate.
 * Any labeler below TARGET gets topped up from the richest available labeler.
 *
 * Usage: node scripts/rebalance-labelers.js
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync } from 'fs'

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC      = 'https://arc.gorillapool.io/v1/tx'
const FEE_RATE = 200
const TARGET   = 10_000_000  // 0.1 BSV per labeler
const MIN_SEND = 1_000_000   // only top up if shortfall > 1M sats

const ENV_FILES = [
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

function loadKey(file) {
  try {
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) return t.slice(10).trim()
    }
  } catch { return null }
}

async function getBalance(address) {
  const r = await fetch(`${WOC}/address/${address}/balance`)
  if (!r.ok) return 0
  const { confirmed } = await r.json()
  return confirmed || 0
}

async function getUtxos(address) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(`${WOC}/address/${address}/unspent`)
    if (r.ok) return r.json()
    if (r.status === 429) { await new Promise(res => setTimeout(res, attempt * 2000)); continue }
    throw new Error(`WoC fetch failed: ${r.status}`)
  }
  throw new Error('WoC rate limited')
}

async function sendFunds(srcKey, destAddress, amount) {
  const priv    = PrivateKey.fromHex(srcKey)
  const srcAddr = priv.toPublicKey().toAddress('mainnet').toString()
  const script  = new P2PKH().lock(srcAddr)

  const utxos   = await getUtxos(srcAddr)
  const usable  = utxos.sort((a, b) => b.value - a.value)
  const selected = []
  let total = 0
  for (const u of usable) {
    selected.push(u)
    total += u.value
    if (total >= amount + 10_000) break
  }

  if (total < amount + 10_000) throw new Error(`Insufficient: ${total} sats, need ${amount + 10_000}`)

  const tx = new Transaction()
  for (const u of selected) {
    const stub = { outputs: [] }
    stub.outputs[u.tx_pos] = { satoshis: u.value }
    tx.addInput({
      sourceTXID: u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      sequence: 0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.value, script),
    })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(destAddress), satoshis: amount })
  tx.addOutput({ lockingScript: new P2PKH().lock(srcAddr), change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const hex  = tx.toHex()
  const txid = tx.id('hex')

  const [arcRes, wocRes] = await Promise.allSettled([
    fetch(ARC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawTx: hex }) })
      .then(r => r.text()).then(body => ({ body })).catch(e => ({ body: e.message })),
    fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }) })
      .then(async r => { const body = await r.text(); return { body } }).catch(e => ({ body: e.message })),
  ])

  return { txid, arc: arcRes.value?.body?.slice(0, 80), woc: wocRes.value?.body?.slice(0, 80) }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n⚖ MESA Labeler Rebalancer\n' + '─'.repeat(50))
console.log(`  Target per labeler: ${TARGET.toLocaleString()} sats (0.1 BSV)`)
console.log(`  Minimum top-up:     ${MIN_SEND.toLocaleString()} sats\n`)

// Load all wallets
const wallets = []
for (const [file, label] of ENV_FILES) {
  const key = loadKey(file)
  if (!key) { console.log(`  ${label}: env file not found`); continue }
  const priv    = PrivateKey.fromHex(key)
  const address = priv.toPublicKey().toAddress('mainnet').toString()
  wallets.push({ label, key, address })
}

// Fetch balances
console.log('Fetching balances...')
for (const w of wallets) {
  w.balance = await getBalance(w.address)
  const flag = w.balance >= TARGET ? '✓' : w.balance < MIN_SEND ? '✗ CRITICAL' : '⚠ LOW'
  console.log(`  ${w.label.padEnd(12)} ${String(w.balance).padStart(12)} sats  ${flag}`)
  await new Promise(r => setTimeout(r, 300))
}

// Identify who needs funds and who can give
const needy = wallets.filter(w => w.balance < TARGET - MIN_SEND)
  .sort((a, b) => a.balance - b.balance)

if (needy.length === 0) {
  console.log('\n✅ All labelers are sufficiently funded. No rebalancing needed.')
  process.exit(0)
}

console.log(`\n${needy.length} labeler(s) need top-up:`)
for (const n of needy) console.log(`  ${n.label}: needs ${(TARGET - n.balance).toLocaleString()} sats`)

// Sort donors richest-first
wallets.sort((a, b) => b.balance - a.balance)

console.log('\nSending...\n')
for (const recipient of needy) {
  const needed = TARGET - recipient.balance
  if (needed < MIN_SEND) continue

  // Find a donor with enough surplus
  const donor = wallets.find(w =>
    w.label !== recipient.label &&
    w.balance >= TARGET + needed + 20_000  // keep donor above target
  )

  if (!donor) {
    console.log(`  ⚠ No donor available for ${recipient.label} (need ${needed.toLocaleString()} sats)`)
    continue
  }

  try {
    console.log(`  ${donor.label} → ${recipient.label}: ${needed.toLocaleString()} sats`)
    const { txid, arc, woc } = await sendFunds(donor.key, recipient.address, needed)
    console.log(`    txid: ${txid}`)
    console.log(`    ARC:  ${arc}`)
    console.log(`    WoC:  ${woc}`)
    console.log(`    https://whatsonchain.com/tx/${txid}\n`)

    // Update local balances
    donor.balance    -= needed
    recipient.balance = TARGET
  } catch (err) {
    console.log(`  ✗ Failed: ${err.message}`)
  }

  await new Promise(r => setTimeout(r, 1000))
}

console.log('─'.repeat(50))
console.log('Done. Wait ~30s for txs to propagate, then restart agents.\n')
