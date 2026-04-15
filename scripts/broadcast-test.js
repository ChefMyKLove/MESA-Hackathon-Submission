/**
 * scripts/broadcast-test.js — Diagnose why broadcasts are not landing on-chain.
 *
 * Builds a real signed tx (1 sat self-send from labeler-1) and hits every
 * broadcast endpoint with FULL error output. No fire-and-forget — every
 * response is printed so you can see exactly what ARC/WoC is rejecting.
 *
 * Usage:
 *   node --env-file=.env.labeler1 scripts/broadcast-test.js
 */
import { PrivateKey, PublicKey, P2PKH, Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk'

const KEY = process.env.AGENT_KEY
if (!KEY) { console.error('Run with: node --env-file=.env.labeler1 scripts/broadcast-test.js'); process.exit(1) }

const WOC = 'https://api.whatsonchain.com/v1/bsv/main'

// ── 1. Derive address ─────────────────────────────────────────────────────────

const priv    = PrivateKey.fromHex(KEY)
const address = priv.toPublicKey().toAddress('mainnet').toString()
console.log(`\n🔍 Broadcast Diagnostic`)
console.log(`   Wallet: ${address}\n`)

// ── 2. Fetch UTXOs ────────────────────────────────────────────────────────────

console.log('① Fetching UTXOs from WoC...')
const utxoResp = await fetch(`${WOC}/address/${address}/unspent`)
if (!utxoResp.ok) {
  console.error(`   ✗ WoC UTXO fetch failed: ${utxoResp.status} ${await utxoResp.text()}`)
  process.exit(1)
}
const utxos = await utxoResp.json()
console.log(`   Found ${utxos.length} UTXOs`)
if (utxos.length === 0) {
  console.error('   ✗ No UTXOs — fund this address first')
  process.exit(1)
}
utxos.forEach(u => console.log(`     ${u.tx_hash}:${u.tx_pos}  ${u.value} sats`))

// Pick largest UTXO
const u = utxos.sort((a, b) => b.value - a.value)[0]
console.log(`\n   Using UTXO: ${u.tx_hash}:${u.tx_pos}  (${u.value} sats)`)

// ── 3. Build tx ───────────────────────────────────────────────────────────────

console.log('\n② Building tx (1 sat self-send + OP_RETURN "MESA TEST")...')
const myScript = new P2PKH().lock(address)

// Stub for calculateChange
const srcStub = { outputs: [] }
srcStub.outputs[u.tx_pos] = { satoshis: u.value }

const tx = new Transaction()
tx.addInput({
  sourceTXID:        u.tx_hash,
  sourceOutputIndex: u.tx_pos,
  sequence:          0xffffffff,
  sourceTransaction: srcStub,
  unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.value, myScript),
})

// 1-sat output to self
tx.addOutput({
  lockingScript: new P2PKH().lock(address),
  satoshis: 1,
})

// OP_RETURN "MESA TEST"
const data    = Buffer.from('MESA BROADCAST TEST', 'utf8')
const lenHex  = data.length <= 75
  ? data.length.toString(16).padStart(2, '0')
  : '4c' + data.length.toString(16).padStart(2, '0')
const scriptHex = '006a' + lenHex + data.toString('hex')
tx.addOutput({ lockingScript: Script.fromHex(scriptHex), satoshis: 0 })

// Change
tx.addOutput({ lockingScript: new P2PKH().lock(address), change: true })

await tx.fee(new SatoshisPerKilobyte(1000))
await tx.sign()

const hex  = tx.toHex()
const txid = tx.id('hex')
console.log(`   txid: ${txid}`)
console.log(`   hex length: ${hex.length / 2} bytes`)
console.log(`   hex (first 80 chars): ${hex.slice(0, 80)}...`)

// ── 4. Try every broadcast endpoint — SHOW ALL RESPONSES ────────────────────

console.log('\n③ Broadcasting — showing raw responses:\n')

// GorillaPool ARC bulk
console.log('  [A] GorillaPool ARC bulk POST /v1/txs')
try {
  const r = await fetch('https://arc.gorillapool.io/v1/txs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ rawTx: hex }]),
  })
  const body = await r.text()
  console.log(`      status: ${r.status}`)
  console.log(`      body:   ${body.slice(0, 300)}`)
} catch (e) { console.log(`      ERROR: ${e.message}`) }

// GorillaPool ARC single
console.log('\n  [B] GorillaPool ARC single POST /v1/tx')
try {
  const r = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: hex }),
  })
  const body = await r.text()
  console.log(`      status: ${r.status}`)
  console.log(`      body:   ${body.slice(0, 300)}`)
} catch (e) { console.log(`      ERROR: ${e.message}`) }

// TAAL ARC (alternative ARC provider)
console.log('\n  [C] TAAL ARC POST /v1/tx')
try {
  const r = await fetch('https://arc.taal.com/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: hex }),
  })
  const body = await r.text()
  console.log(`      status: ${r.status}`)
  console.log(`      body:   ${body.slice(0, 300)}`)
} catch (e) { console.log(`      ERROR: ${e.message}`) }

// WhatsOnChain
console.log('\n  [D] WhatsOnChain POST /tx/raw')
try {
  const r = await fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: hex }),
  })
  const body = await r.text()
  console.log(`      status: ${r.status}`)
  console.log(`      body:   ${body.slice(0, 300)}`)
} catch (e) { console.log(`      ERROR: ${e.message}`) }

// ── 5. Verify on WoC ─────────────────────────────────────────────────────────

console.log('\n④ Checking WoC for txid...')
await new Promise(r => setTimeout(r, 2000))
try {
  const r = await fetch(`${WOC}/tx/${txid}`)
  if (r.ok) {
    console.log(`   ✅ TX CONFIRMED ON WoC: https://whatsonchain.com/tx/${txid}`)
  } else {
    console.log(`   ✗ Not found on WoC (${r.status}) — broadcast failed`)
    console.log(`   Check endpoint responses above for rejection reason.`)
  }
} catch (e) { console.log(`   ✗ WoC check failed: ${e.message}`) }

console.log()
