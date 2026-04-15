/**
 * scripts/sweep.js — Nuclear UTXO reset
 *
 * Spends ALL confirmed UTXOs from a wallet in a single high-fee tx
 * back to the same address. This double-spends the inputs of any stuck
 * mempool txs, invalidating the entire stuck chain and giving you a
 * single fresh confirmed UTXO to start from.
 *
 * Submit ONLY to ARC (not WoC) — WoC rejects double-spend attempts.
 * ARC accepts the higher-fee version and miners prefer it.
 *
 * Usage:
 *   node --env-file=.env.labeler1 scripts/sweep.js
 *   node --env-file=.env.orchestrator scripts/sweep.js
 *
 * Run for each wallet that has stuck txs. Then run fanout.js to re-split.
 */
import { PrivateKey, P2PKH, Transaction, Script, SatoshisPerKilobyte } from '@bsv/sdk'

const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const FEE_RATE = 5000  // 5 sat/byte — aggressive priority, nukes stuck txs

const KEY = process.env.AGENT_KEY
if (!KEY) {
  console.error('Usage: node --env-file=.env.labeler1 scripts/sweep.js')
  process.exit(1)
}

const priv    = PrivateKey.fromHex(KEY)
const address = priv.toPublicKey().toAddress('mainnet').toString()

console.log(`\n💣 UTXO Sweep — ${address}\n`)

// ── Fetch all UTXOs ───────────────────────────────────────────────────────────

console.log('① Fetching UTXOs from WoC...')
const resp = await fetch(`${WOC}/address/${address}/unspent`)
if (!resp.ok) {
  console.error(`   ✗ WoC fetch failed: ${resp.status}`)
  process.exit(1)
}
const all = await resp.json()

const confirmed = all.filter(u => u.height > 0)
const mempool   = all.filter(u => u.height <= 0)

console.log(`   Total UTXOs:     ${all.length}`)
console.log(`   Confirmed:       ${confirmed.length}`)
console.log(`   Mempool/stuck:   ${mempool.length}`)

if (all.length === 0) {
  console.log('\n   ✗ No UTXOs found — wallet may be empty or fully stuck.')
  console.log('   Wait for stuck txs to expire, or fund a fresh wallet.')
  process.exit(0)
}

// Prefer confirmed UTXOs for a clean double-spend.
// Fall back to mempool UTXOs if nothing confirmed (CPFP attempt).
const utxos = confirmed.length > 0 ? confirmed : mempool
const mode  = confirmed.length > 0 ? 'DOUBLE-SPEND (invalidates stuck txs)' : 'CPFP (chains off mempool)'

console.log(`\n   Mode: ${mode}`)
utxos.forEach(u => {
  const tag = u.height > 0 ? `block ${u.height}` : 'mempool'
  console.log(`   ${u.tx_hash.slice(0, 16)}…:${u.tx_pos}  ${u.value} sats  [${tag}]`)
})

const totalIn = utxos.reduce((s, u) => s + u.value, 0)
console.log(`\n   Total input: ${totalIn} sats`)

// ── Build consolidation tx ────────────────────────────────────────────────────

console.log('\n② Building consolidation tx...')

const myScript = new P2PKH().lock(address)
const tx = new Transaction()

for (const u of utxos) {
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

// Single output back to self — all sats minus fee
tx.addOutput({
  lockingScript: new P2PKH().lock(address),
  change: true,
})

await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
await tx.sign()

const hex    = tx.toHex()
const txid   = tx.id('hex')
const outSats = tx.outputs[0]?.satoshis ?? 0
const fee    = totalIn - outSats

console.log(`   txid:     ${txid}`)
console.log(`   fee:      ${fee} sats  (${(fee / (hex.length / 2)).toFixed(2)} sat/byte)`)
console.log(`   output:   ${outSats} sats back to ${address}`)

if (outSats <= 0) {
  console.error('\n   ✗ Fee exceeds balance — not enough sats to sweep.')
  process.exit(1)
}

// ── Broadcast via ARC only ───────────────────────────────────────────────────
// WoC rejects double-spend attempts. ARC accepts the higher-fee version
// and miners will include it over the stuck lower-fee version.

console.log('\n③ Broadcasting via ARC (double-spend attempt)...')

try {
  const r = await fetch('https://arc.gorillapool.io/v1/tx', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ rawTx: hex }),
  })
  const body = await r.text()
  console.log(`   ARC status: ${r.status}`)
  console.log(`   ARC body:   ${body.slice(0, 200)}`)

  if (r.ok || body.includes('already')) {
    console.log(`\n   ✅ Submitted to ARC`)
    console.log(`   Monitor: https://arc.gorillapool.io/v1/tx/${txid}`)
    console.log(`   WoC (after mining): https://whatsonchain.com/tx/${txid}`)
  }
} catch (e) {
  console.error(`   ✗ ARC error: ${e.message}`)
}

// Also try WoC — it might accept if it doesn't have the stuck tx in mempool
console.log('\n   Trying WoC too...')
try {
  const r = await fetch(`${WOC}/tx/raw`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ txhex: hex }),
  })
  const body = await r.text()
  console.log(`   WoC status: ${r.status}  ${body.slice(0, 100)}`)
} catch (e) {
  console.error(`   WoC error: ${e.message}`)
}

console.log('\n④ Next steps:')
console.log('   1. Check ARC link above — should show SEEN_ON_NETWORK')
console.log('   2. Wait for next BSV block (~10 min)')
console.log('   3. Once confirmed on WoC, run: node scripts/fanout.js')
console.log('   4. Then start production: npm start\n')
