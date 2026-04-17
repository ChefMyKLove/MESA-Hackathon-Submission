/**
 * scripts/recover-nexus.js
 *
 * Recovers the ~3.43 BSV stranded in the old Nexus orchestrator wallet.
 * WoC /unspent caps at 1000 UTXOs (oldest first = all 1-sat dust) so the large
 * funded UTXOs are invisible there. Blockchair returns UTXOs sorted by value
 * descending with no cap — we find them instantly.
 *
 * Distributes recovered sats equally across all 10 labeler wallets.
 *
 * Usage:  node scripts/recover-nexus.js
 * Run:    while service is STOPPED and chains have confirmed (~15 min after stop)
 */

import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync } from 'fs'

const OLD_KEY  = '9b080c6221282881e08d631fe9c225360b32db6dadc0f917ecf760f39a15b746'
const ARC      = 'https://arc.gorillapool.io/v1/tx'
const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const FEE_RATE = 200   // sat/KB
const MIN_SATS = 100_000  // ignore dust

const LABELER_FILES = [
  '.env.labeler1',  '.env.labeler2',  '.env.labeler3',  '.env.labeler4',  '.env.labeler5',
  '.env.labeler6',  '.env.labeler7',  '.env.labeler8',  '.env.labeler9',  '.env.labeler10',
]

const sleep = ms => new Promise(r => setTimeout(r, ms))

function loadAddr(file) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (t.startsWith('AGENT_KEY='))
      return PrivateKey.fromHex(t.slice(10).trim()).toPublicKey().toAddress('mainnet').toString()
  }
  throw new Error(`No AGENT_KEY in ${file}`)
}

const priv     = PrivateKey.fromHex(OLD_KEY)
const srcAddr  = priv.toPublicKey().toAddress('mainnet').toString()
const srcScript = new P2PKH().lock(srcAddr)
const dstAddrs  = LABELER_FILES.map(loadAddr)

console.log(`\n🧹 Nexus Recovery`)
console.log(`   From: ${srcAddr}`)
console.log(`   To:   ${dstAddrs.length} labeler wallets (equal split)\n`)

// ── 1. Check balance ───────────────────────────────────────────────────────
const balResp = await fetch(`${WOC}/address/${srcAddr}/balance`)
if (!balResp.ok) throw new Error(`WoC balance failed: ${balResp.status}`)
const { confirmed, unconfirmed } = await balResp.json()
console.log(`Confirmed:   ${confirmed.toLocaleString()} sats`)
console.log(`Unconfirmed: ${(unconfirmed || 0).toLocaleString()} sats`)

if (confirmed < 10_000) {
  console.log('\n⚠  Nothing confirmed yet — wait for the next BSV block and retry.')
  process.exit(1)
}

// ── 2. Find large UTXOs — try multiple APIs ───────────────────────────────
console.log('\nSearching for large UTXOs (no 1000-cap)...')
let utxos = []

// API 1: GorillaPool 1Sat ordinals UTXO index (full BSV UTXO coverage)
async function tryGorillaPool() {
  console.log('  Trying GorillaPool 1Sat API...')
  try {
    const r = await fetch(`https://v3.ordinals.gorillapool.io/utxos/${srcAddr}?limit=1000&offset=0&bsv20=false`)
    if (!r.ok) { console.log(`  → HTTP ${r.status}`); return [] }
    const data = await r.json()
    const rows = Array.isArray(data) ? data : (data?.utxos ?? data?.data ?? [])
    return rows
      .filter(u => (u.satoshis ?? u.value ?? u.amt ?? 0) >= MIN_SATS)
      .map(u => ({
        transaction_hash: u.txid ?? u.tx_hash ?? u.txHash,
        index:            u.vout  ?? u.tx_pos  ?? u.outputIndex ?? 0,
        value:            u.satoshis ?? u.value ?? u.amt,
      }))
  } catch (e) { console.log(`  → ${e.message}`); return [] }
}

// API 2: WoC with offset param (undocumented — worth trying)
async function tryWocOffset() {
  console.log('  Trying WoC with large limit...')
  const results = []
  for (let page = 1; page <= 5; page++) {
    try {
      const r = await fetch(`${WOC}/address/${srcAddr}/unspent?page=${page}`)
      if (!r.ok) { console.log(`  → WoC page ${page}: HTTP ${r.status}`); break }
      const data = await r.json()
      if (!Array.isArray(data) || data.length === 0) break
      const large = data.filter(u => u.value >= MIN_SATS)
      results.push(...large.map(u => ({ transaction_hash: u.tx_hash, index: u.tx_pos, value: u.value })))
      console.log(`  → page ${page}: ${data.length} UTXOs, ${large.length} large`)
      if (data.length < 1000) break
      await sleep(400)
    } catch (e) { break }
  }
  return results
}

// API 3: Bitails BSV indexer
async function tryBitails() {
  console.log('  Trying Bitails...')
  try {
    const r = await fetch(`https://api.bitails.io/address/${srcAddr}/unspent?limit=100&offset=0`)
    if (!r.ok) { console.log(`  → HTTP ${r.status}`); return [] }
    const data = await r.json()
    const rows = Array.isArray(data) ? data : (data?.unspent ?? data?.utxos ?? [])
    return rows
      .filter(u => (u.satoshis ?? u.value ?? 0) >= MIN_SATS)
      .map(u => ({
        transaction_hash: u.txid ?? u.tx_hash,
        index:            u.vout ?? u.tx_pos ?? u.n ?? 0,
        value:            u.satoshis ?? u.value,
      }))
  } catch (e) { console.log(`  → ${e.message}`); return [] }
}

// Try each API in sequence
utxos = await tryGorillaPool()
if (utxos.length === 0) { await sleep(500); utxos = await tryWocOffset() }
if (utxos.length === 0) { await sleep(500); utxos = await tryBitails() }

if (utxos.length === 0) {
  console.log('\n✗ All APIs failed to find large UTXOs.')
  console.log('  The funds are there (confirmed balance: ' + confirmed.toLocaleString() + ' sats).')
  console.log('  Run ensure-overnight.js — the orchestrator has enough to cover the at-risk labelers.')
  console.log('  Nexus funds can be recovered post-hackathon via JungleBus.')
  process.exit(1)
}

const totalIn = utxos.reduce((s, u) => s + u.value, 0)
console.log(`\nFound ${utxos.length} large UTXOs = ${totalIn.toLocaleString()} sats`)
utxos.forEach(u =>
  console.log(`  ${u.transaction_hash.slice(0, 20)}... vout=${u.index}  ${u.value.toLocaleString()} sats`)
)

// ── 3. Build sweep tx — split evenly across all labelers ──────────────────
console.log('\nBuilding sweep transaction...')
const tx = new Transaction()

for (const u of utxos) {
  const stub = { outputs: [] }
  stub.outputs[u.index] = { satoshis: u.value }
  tx.addInput({
    sourceTXID:        u.transaction_hash,
    sourceOutputIndex: u.index,
    sequence:          0xffffffff,
    sourceTransaction: stub,
    unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.value, srcScript),
  })
}

// Equal split — last wallet absorbs fee remainder via change:true
const perWallet = Math.floor(totalIn / dstAddrs.length)
for (let i = 0; i < dstAddrs.length - 1; i++) {
  tx.addOutput({ lockingScript: new P2PKH().lock(dstAddrs[i]), satoshis: perWallet })
}
tx.addOutput({ lockingScript: new P2PKH().lock(dstAddrs[dstAddrs.length - 1]), change: true })

await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
await tx.sign()

const hex    = tx.toHex()
const txid   = tx.id('hex')
const outSum = tx.outputs.reduce((s, o) => s + o.satoshis, 0)
const fee    = totalIn - outSum

console.log(`  txid: ${txid}`)
console.log(`  fee:  ${fee} sats (${(fee / totalIn * 100).toFixed(2)}%)`)
dstAddrs.forEach((addr, i) =>
  console.log(`  L${String(i + 1).padStart(2)}: +${tx.outputs[i].satoshis.toLocaleString().padStart(12)} sats → ${addr}`)
)

// ── 4. Broadcast ──────────────────────────────────────────────────────────
console.log('\nBroadcasting...')
const [arcR, wocR] = await Promise.allSettled([
  fetch(ARC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: hex }),
  }).then(r => r.text()).catch(e => e.message),

  fetch(`${WOC}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: hex }),
  }).then(r => r.text()).catch(e => e.message),
])

const arc = arcR.value || ''
const woc = wocR.value || ''
console.log(`  ARC: ${arc.slice(0, 120)}`)
console.log(`  WoC: ${woc.slice(0, 120)}`)
console.log(`  https://whatsonchain.com/tx/${txid}`)

if (arc.includes('"SEEN_ON_NETWORK"') || arc.includes('"MINED"') || arc.includes('"txid"') || woc.length < 80) {
  console.log(`\n✅ Nexus recovered! ${outSum.toLocaleString()} sats distributed to ${dstAddrs.length} labelers`)
  console.log(`   ~${perWallet.toLocaleString()} sats each`)
  console.log(`\n   ⏳ Wait for next BSV block (~10 min) then run: node scripts/ensure-overnight.js`)
} else {
  console.log(`\n⚠  Broadcast unclear — check WoC link above before proceeding`)
}
