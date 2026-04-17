/**
 * scripts/topup-labeler.js — Send sats from one labeler to another.
 * Safe to run while agents are running — uses WoC confirmed UTXOs only.
 *
 * Usage:
 *   node scripts/topup-labeler.js <from-labeler-number> <to-labeler-number> [amount-sats]
 *
 * Examples:
 *   node scripts/topup-labeler.js 8 9              # send all visible from L8 → L9
 *   node scripts/topup-labeler.js 6 4 5000000      # send 5M sats from L6 → L4
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync } from 'fs'

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC      = 'https://arc.gorillapool.io/v1/tx'
const FEE_RATE = 200

const [,, fromArg, toArg, amountArg] = process.argv
if (!fromArg || !toArg) {
  console.error('Usage: node scripts/topup-labeler.js <from> <to> [amount]')
  console.error('Example: node scripts/topup-labeler.js 8 9')
  process.exit(1)
}

function loadKey(num) {
  const file = `.env.labeler${num}`
  const content = readFileSync(file, 'utf8')
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (t.startsWith('AGENT_KEY=')) return t.slice(10).trim()
  }
  throw new Error(`No AGENT_KEY in ${file}`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const srcKey  = loadKey(fromArg)
const dstKey  = loadKey(toArg)
const srcPriv = PrivateKey.fromHex(srcKey)
const dstPriv = PrivateKey.fromHex(dstKey)
const srcAddr = srcPriv.toPublicKey().toAddress('mainnet').toString()
const dstAddr = dstPriv.toPublicKey().toAddress('mainnet').toString()

console.log(`\n💸 Labeler Topup`)
console.log(`   From: labeler-${fromArg} (${srcAddr})`)
console.log(`   To:   labeler-${toArg}   (${dstAddr})\n`)

// Fetch UTXOs
console.log('Fetching UTXOs...')
let utxos
for (let attempt = 1; attempt <= 5; attempt++) {
  const r = await fetch(`${WOC}/address/${srcAddr}/unspent`)
  if (r.ok) { utxos = await r.json(); break }
  if (r.status === 429) { await sleep(attempt * 2000); continue }
  throw new Error(`WoC ${r.status}`)
}

const sorted = utxos.sort((a, b) => b.value - a.value)
const totalVisible = sorted.reduce((s, u) => s + u.value, 0)
console.log(`   ${sorted.length} UTXOs visible, ${totalVisible.toLocaleString()} sats`)

if (totalVisible < 2000) {
  console.error('   ✗ Nothing to send'); process.exit(1)
}

// Determine send amount
const sendAll    = !amountArg
const sendAmount = sendAll ? totalVisible : parseInt(amountArg)

if (!sendAll && totalVisible < sendAmount + 5000) {
  console.error(`   ✗ Only ${totalVisible.toLocaleString()} visible, need ${sendAmount.toLocaleString()}`)
  process.exit(1)
}

console.log(`   Sending: ${sendAll ? 'ALL (sweep)' : sendAmount.toLocaleString() + ' sats'}`)

// Select UTXOs
const script   = new P2PKH().lock(srcAddr)
const selected = sendAll ? sorted : []
let total      = sendAll ? totalVisible : 0
if (!sendAll) {
  for (const u of sorted) {
    selected.push(u)
    total += u.value
    if (total >= sendAmount + 10_000) break
  }
}

// Build tx
const tx = new Transaction()
for (const u of selected) {
  const stub = { outputs: [] }
  stub.outputs[u.tx_pos] = { satoshis: u.value }
  tx.addInput({
    sourceTXID: u.tx_hash,
    sourceOutputIndex: u.tx_pos,
    sequence: 0xffffffff,
    sourceTransaction: stub,
    unlockingScriptTemplate: new P2PKH().unlock(srcPriv, 'all', false, u.value, script),
  })
}

if (sendAll) {
  tx.addOutput({ lockingScript: new P2PKH().lock(dstAddr), change: true })
} else {
  tx.addOutput({ lockingScript: new P2PKH().lock(dstAddr), satoshis: sendAmount })
  tx.addOutput({ lockingScript: new P2PKH().lock(srcAddr), change: true })
}

await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
await tx.sign()

const hex     = tx.toHex()
const txid    = tx.id('hex')
const outSats = tx.outputs[0].satoshis
const fee     = sendAll ? total - outSats : total - sendAmount - (tx.outputs[1]?.satoshis ?? 0)

console.log(`\n   txid: ${txid}`)
console.log(`   fee:  ${fee} sats`)
console.log(`   out:  ${outSats.toLocaleString()} sats → labeler-${toArg}`)

// Broadcast
console.log('\nBroadcasting...')
const [arcRes, wocRes] = await Promise.allSettled([
  fetch(ARC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawTx: hex }) })
    .then(r => r.text()).catch(e => e.message),
  fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }) })
    .then(async r => { const b = await r.text(); return b }).catch(e => e.message),
])

const arc = arcRes.value || ''
const woc = wocRes.value || ''
console.log(`   ARC: ${arc.slice(0, 100)}`)
console.log(`   WoC: ${woc.slice(0, 100)}`)
console.log(`   https://whatsonchain.com/tx/${txid}`)

const ok = arc.includes('"SEEN_ON_NETWORK"') || arc.includes('"MINED"') || arc.includes('"txid"') || woc.length < 80
console.log(ok ? `\n✅ Done! ${outSats.toLocaleString()} sats sent to labeler-${toArg}` : `\n⚠ Check WoC link above`)
