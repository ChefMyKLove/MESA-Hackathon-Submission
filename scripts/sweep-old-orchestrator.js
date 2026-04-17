/**
 * scripts/sweep-old-orchestrator.js
 * Recovers funds from the old orchestrator address (285k dust UTXOs hide
 * the real funds from the normal /unspent endpoint).
 *
 * Strategy: fetch recent transaction HISTORY, find large-value UTXOs that
 * way, then sweep them to the new orchestrator address.
 *
 * Usage: node scripts/sweep-old-orchestrator.js
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC      = 'https://arc.gorillapool.io/v1/tx'
const FEE_RATE = 200

const OLD_KEY     = '9b080c6221282881e08d631fe9c225360b32db6dadc0f917ecf760f39a15b746'
const NEW_ADDRESS = '1CXWMmLfqF68jHtLiUGcm4hYW5Me75CUaX'  // new orchestrator
const MIN_VALUE   = 100_000  // only sweep UTXOs worth >100k sats (ignore dust)

const priv    = PrivateKey.fromHex(OLD_KEY)
const address = priv.toPublicKey().toAddress('mainnet').toString()
const script  = new P2PKH().lock(address)

console.log(`\n🧹 Sweeping old orchestrator: ${address}`)
console.log(`   → New address: ${NEW_ADDRESS}\n`)

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function wocGet(path) {
  for (let i = 1; i <= 5; i++) {
    const r = await fetch(`${WOC}${path}`)
    if (r.ok) return r.json()
    if (r.status === 429) { await sleep(i * 2000); continue }
    throw new Error(`WoC ${path} → ${r.status}`)
  }
  throw new Error('WoC rate limited')
}

// ── Step 1: Confirm balance ───────────────────────────────────────────────────
const bal = await wocGet(`/address/${address}/balance`)
console.log(`Balance: ${bal.confirmed.toLocaleString()} sats confirmed`)
if (bal.confirmed < 10_000) {
  console.log('Nothing worth sweeping.')
  process.exit(0)
}

// ── Step 2: Get transaction history, scan for large UTXOs ─────────────────────
// WoC /history returns [{tx_hash, height}] ordered by height asc.
// Topup txs are the most recent — fetch history and scan from the end.
console.log('\nFetching transaction history...')
const history = await wocGet(`/address/${address}/history`)
console.log(`  ${history.length} transactions total`)

// Take last 200 (most recent by block height) — topups are recent
const recent = history.slice(-200).reverse()
console.log(`  Scanning last ${recent.length} transactions for large outputs...\n`)

const candidates = []  // { txid, vout, satoshis }

for (let i = 0; i < recent.length; i++) {
  const { tx_hash } = recent[i]
  try {
    const tx = await wocGet(`/tx/${tx_hash}`)
    for (const out of tx.vout || []) {
      const addrs = out.scriptPubKey?.addresses || []
      if (addrs.includes(address) && out.value * 1e8 > MIN_VALUE) {
        const sats = Math.round(out.value * 1e8)
        candidates.push({ txid: tx_hash, vout: out.n, satoshis: sats })
        console.log(`  ✓ Found: ${tx_hash.slice(0, 16)}... vout=${out.n} → ${sats.toLocaleString()} sats`)
      }
    }
  } catch (err) {
    console.log(`  ⚠ Could not fetch ${tx_hash.slice(0, 16)}...: ${err.message}`)
  }
  if (i % 20 === 19) await sleep(1000)  // rate limit courtesy
}

if (candidates.length === 0) {
  console.log('No large UTXOs found in recent history.')
  console.log('The funds may be in older transactions. Try increasing the scan window.')
  process.exit(1)
}

const totalFound = candidates.reduce((s, c) => s + c.satoshis, 0)
console.log(`\nFound ${candidates.length} large UTXOs totalling ${totalFound.toLocaleString()} sats`)

// ── Step 3: Verify UTXOs are unspent via WoC ──────────────────────────────────
console.log('\nVerifying UTXOs are unspent...')
const unspent = []
for (const c of candidates) {
  try {
    // WoC returns spend info if spent, 404-ish if unspent — check tx outputs
    const r = await fetch(`${WOC}/tx/${c.txid}/out/${c.vout}/spend`)
    if (r.status === 404 || r.status === 204) {
      unspent.push(c)
      console.log(`  ✓ Unspent: ${c.txid.slice(0, 16)}... (${c.satoshis.toLocaleString()} sats)`)
    } else if (r.ok) {
      const spend = await r.json()
      if (!spend?.txid) {
        unspent.push(c)
        console.log(`  ✓ Unspent: ${c.txid.slice(0, 16)}... (${c.satoshis.toLocaleString()} sats)`)
      } else {
        console.log(`  ✗ Already spent: ${c.txid.slice(0, 16)}...`)
      }
    } else {
      // Assume unspent if endpoint behaves unexpectedly
      unspent.push(c)
    }
  } catch { unspent.push(c) }
  await sleep(200)
}

if (unspent.length === 0) {
  console.log('All candidates already spent.')
  process.exit(0)
}

const sweepTotal = unspent.reduce((s, c) => s + c.satoshis, 0)
console.log(`\n${unspent.length} unspent UTXOs, ${sweepTotal.toLocaleString()} sats to sweep`)

// ── Step 4: Build sweep tx ────────────────────────────────────────────────────
console.log('\nBuilding sweep transaction...')
const tx = new Transaction()

for (const u of unspent) {
  const stub = { outputs: [] }
  stub.outputs[u.vout] = { satoshis: u.satoshis }
  tx.addInput({
    sourceTXID: u.txid,
    sourceOutputIndex: u.vout,
    sequence: 0xffffffff,
    sourceTransaction: stub,
    unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.satoshis, script),
  })
}

tx.addOutput({ lockingScript: new P2PKH().lock(NEW_ADDRESS), change: true })
await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
await tx.sign()

const hex  = tx.toHex()
const txid = tx.id('hex')
const fee  = sweepTotal - (tx.outputs[0]?.satoshis ?? 0)
console.log(`  txid: ${txid}`)
console.log(`  fee:  ${fee} sats`)
console.log(`  out:  ${tx.outputs[0].satoshis.toLocaleString()} sats → ${NEW_ADDRESS}`)

// ── Step 5: Broadcast ─────────────────────────────────────────────────────────
console.log('\nBroadcasting...')
const [arcRes, wocRes] = await Promise.allSettled([
  fetch(ARC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: hex }),
  }).then(r => r.text()).then(body => ({ body })).catch(e => ({ body: e.message })),

  fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: hex }),
  }).then(async r => { const body = await r.text(); return { body } }).catch(e => ({ body: e.message })),
])

console.log(`  ARC: ${arcRes.value?.body?.slice(0, 120)}`)
console.log(`  WoC: ${wocRes.value?.body?.slice(0, 120)}`)
console.log(`\n  https://whatsonchain.com/tx/${txid}`)

const arc = arcRes.value?.body || ''
if (arc.includes('"SEEN_ON_NETWORK"') || arc.includes('"MINED"') || arc.includes('"txid"')) {
  console.log(`\n✅ Sweep successful! ${tx.outputs[0].satoshis.toLocaleString()} sats → new orchestrator`)
} else {
  console.log(`\n⚠ Broadcast unclear — check WoC link above`)
}
