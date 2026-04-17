/**
 * scripts/topup-orchestrator.js — Transfer sats from a labeler to the orchestrator.
 *
 * Usage:
 *   node --env-file=.env.labeler7 scripts/topup-orchestrator.js
 */
import { PrivateKey, P2PKH, Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk'

const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC = 'https://arc.gorillapool.io/v1/tx'
const FEE_RATE = 200  // sat/KB

const ORCH_ADDR = '1CXWMmLfqF68jHtLiUGcm4hYW5Me75CUaX'  // new orchestrator
const AMOUNT   = 20_000_000  // 0.2 BSV

const KEY = process.env.AGENT_KEY
if (!KEY) { console.error('Usage: node --env-file=.env.labeler7 scripts/topup-orchestrator.js'); process.exit(1) }

const priv    = PrivateKey.fromHex(KEY)
const address = priv.toPublicKey().toAddress('mainnet').toString()

console.log(`\nTopup Orchestrator`)
console.log(`  From:   ${address}`)
console.log(`  To:     ${ORCH_ADDR}`)
console.log(`  Amount: ${AMOUNT.toLocaleString()} sats\n`)

// Fetch UTXOs
console.log('① Fetching UTXOs...')
let all
for (let attempt = 1; attempt <= 10; attempt++) {
  const resp = await fetch(`${WOC}/address/${address}/unspent`)
  if (resp.ok) { all = await resp.json(); break }
  if (resp.status === 429) {
    console.log(`   WoC rate limited, retrying in ${attempt * 2}s... (attempt ${attempt}/10)`)
    await new Promise(r => setTimeout(r, attempt * 2000))
    continue
  }
  console.error('WoC fetch failed:', resp.status); process.exit(1)
}
if (!all) { console.error('WoC rate limited after 10 retries'); process.exit(1) }

const usable = all.sort((a, b) => b.value - a.value)
const totalAvailable = usable.reduce((s, u) => s + u.value, 0)
console.log(`   ${usable.length} UTXOs, total ${totalAvailable.toLocaleString()} sats`)

if (totalAvailable < AMOUNT + 1000) {
  console.error(`   ✗ Insufficient funds: ${totalAvailable} sats available, need ${AMOUNT + 1000}`)
  process.exit(1)
}

// Select UTXOs
const myScript = new P2PKH().lock(address)
const selected = []
let total = 0
for (const u of usable) {
  selected.push(u)
  total += u.value
  if (total >= AMOUNT + 10_000) break
}
console.log(`   Selected ${selected.length} UTXOs (${total.toLocaleString()} sats)`)

// Build tx
console.log('\n② Building transaction...')
const tx = new Transaction()

for (const u of selected) {
  const srcStub = { outputs: [] }
  srcStub.outputs[u.tx_pos] = { satoshis: u.value }
  tx.addInput({
    sourceTXID:        u.tx_hash,
    sourceOutputIndex: u.tx_pos,
    sequence:          0xffffffff,
    sourceTransaction: srcStub,
    unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.value, myScript),
  })
}

// Payment output to orchestrator
tx.addOutput({ lockingScript: new P2PKH().lock(ORCH_ADDR), satoshis: AMOUNT })
// Change back to self
tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true })

await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
await tx.sign()

const hex    = tx.toHex()
const txid   = tx.id('hex')
const outSats = tx.outputs[0]?.satoshis ?? 0
const fee    = total - outSats - (tx.outputs[1]?.satoshis ?? 0)

console.log(`   txid: ${txid}`)
console.log(`   fee:  ${fee} sats`)
console.log(`   out:  ${outSats.toLocaleString()} sats → orchestrator`)

// Broadcast to BOTH and wait for result
console.log('\n③ Broadcasting...')

const [arcResult, wocResult] = await Promise.allSettled([
  fetch(ARC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: hex }),
  }).then(r => r.text()).then(body => ({ ok: true, body })).catch(e => ({ ok: false, body: e.message })),

  fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: hex }),
  }).then(async r => { const body = await r.text(); return { ok: r.status < 300 || body.includes('already'), body } }).catch(e => ({ ok: false, body: e.message })),
])

const arc = arcResult.value
const woc = wocResult.value

console.log(`   ARC: ${arc.body?.slice(0, 120)}`)
console.log(`   WoC: ${woc.body?.slice(0, 120)}`)

if (arc.body?.includes('"SEEN_ON_NETWORK"') || arc.body?.includes('"MINED"') || arc.body?.includes('"txid"') || woc.body?.length < 80) {
  console.log(`\n✅ Broadcast successful!`)
  console.log(`   txid: ${txid}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
} else {
  console.log(`\n⚠ Broadcast status unclear — check WoC link:`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)
}
