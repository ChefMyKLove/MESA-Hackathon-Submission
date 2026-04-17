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

// ── 2. Find large UTXOs via Blockchair (sorted by value desc, no cap) ─────
console.log('\nSearching for large UTXOs via Blockchair...')
const utxos = []
let offset = 0

while (true) {
  const url =
    `https://api.blockchair.com/bitcoin-sv/outputs` +
    `?q=recipient(${srcAddr}),is_spent(false)` +
    `&s=value(desc)&limit=100&offset=${offset}`

  let data
  for (let i = 1; i <= 6; i++) {
    const r = await fetch(url)
    if (r.ok) { data = await r.json(); break }
    if (r.status === 429) { console.log(`  rate limited, waiting ${i * 3}s...`); await sleep(i * 3000); continue }
    throw new Error(`Blockchair ${r.status}: ${await r.text()}`)
  }

  const rows  = data?.data ?? []
  const large = rows.filter(r => r.value >= MIN_SATS)
  utxos.push(...large)

  console.log(`  page ${Math.floor(offset / 100) + 1}: ${rows.length} rows, ${large.length} >= ${MIN_SATS.toLocaleString()} sats`)

  // Sorted by value desc — once values drop below threshold, done
  if (rows.length < 100 || (rows.length > 0 && rows[rows.length - 1].value < MIN_SATS)) break
  offset += 100
  await sleep(500)
}

if (utxos.length === 0) {
  console.log('\n✗ No large UTXOs found. Either chains not confirmed yet (wait ~15 min after stop) or already swept.')
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
