/**
 * scripts/ensure-overnight.js
 *
 * Guarantees every labeler has 20M+ sats in a SINGLE clean confirmed UTXO
 * before you go to bed. Sends from the orchestrator wallet.
 *
 * Also detects the "dust UTXO" problem (labeler has 1000+ old UTXOs hiding
 * its real balance). For those wallets, it generates a fresh key, sweeps
 * funds via Blockchair, and updates the local .env file. It then prints the
 * Railway env var you need to update before restarting.
 *
 * Usage:  node scripts/ensure-overnight.js
 * Run:    AFTER recover-nexus.js has confirmed (~10 min after broadcasting it)
 *         while service is STOPPED
 */

import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync, writeFileSync } from 'fs'

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC      = 'https://arc.gorillapool.io/v1/tx'
const FEE_RATE = 200
const TARGET   = 15_000_000   // sats per labeler (lowered from 20M — orchestrator has 68M for 10 wallets)
const DUST_THRESHOLD = 900    // if /unspent returns this many UTXOs, wallet has the dust problem

const sleep = ms => new Promise(r => setTimeout(r, ms))

function loadKey(file) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (t.startsWith('AGENT_KEY=')) return t.slice(10).trim()
  }
  throw new Error(`No AGENT_KEY in ${file}`)
}

function updateEnvKey(file, newKey) {
  const content = readFileSync(file, 'utf8')
  const updated = content
    .split('\n')
    .map(line => line.trim().startsWith('AGENT_KEY=') ? `AGENT_KEY=${newKey}` : line)
    .join('\n')
  writeFileSync(file, updated, 'utf8')
}

async function wocGet(path) {
  for (let i = 1; i <= 5; i++) {
    const r = await fetch(`${WOC}${path}`)
    if (r.ok) return r.json()
    if (r.status === 429) { await sleep(i * 2000); continue }
    throw new Error(`WoC ${r.status} ${path}`)
  }
  throw new Error('WoC rate limited')
}

async function findLargeUtxos(address, minSats = 100_000) {
  // GorillaPool — no UTXO cap, BSV-native, primary choice
  try {
    console.log(`   Trying GorillaPool...`)
    const r = await fetch(`https://v3.ordinals.gorillapool.io/utxos/${address}?limit=1000&offset=0&bsv20=false`)
    if (r.ok) {
      const data = await r.json()
      const rows = Array.isArray(data) ? data : (data?.utxos ?? data?.data ?? [])
      const large = rows
        .filter(u => (u.satoshis ?? u.value ?? u.amt ?? 0) >= minSats)
        .map(u => ({
          transaction_hash: u.txid ?? u.tx_hash ?? u.txHash,
          index:            u.vout ?? u.tx_pos ?? u.outputIndex ?? 0,
          value:            u.satoshis ?? u.value ?? u.amt,
        }))
      if (large.length > 0) { console.log(`   → GorillaPool: ${large.length} large UTXOs`); return large }
      console.log(`   → GorillaPool: 0 large UTXOs (total rows: ${rows.length})`)
    } else { console.log(`   → GorillaPool: HTTP ${r.status}`) }
  } catch (e) { console.log(`   → GorillaPool: ${e.message}`) }

  await sleep(500)

  // Blockchair — fallback
  try {
    console.log(`   Trying Blockchair...`)
    const url = `https://api.blockchair.com/bitcoin-sv/outputs` +
      `?q=recipient(${address}),is_spent(false)&s=value(desc)&limit=50&offset=0`
    for (let i = 1; i <= 3; i++) {
      const r = await fetch(url)
      if (r.ok) {
        const data = await r.json()
        const rows = data?.data ?? []
        const large = rows.filter(u => u.value >= minSats)
        if (large.length > 0) { console.log(`   → Blockchair: ${large.length} large UTXOs`); return large }
        console.log(`   → Blockchair: 0 large UTXOs (total rows: ${rows.length})`)
        break
      }
      if (r.status === 429) { await sleep(i * 3000); continue }
      console.log(`   → Blockchair: HTTP ${r.status}`); break
    }
  } catch (e) { console.log(`   → Blockchair: ${e.message}`) }

  await sleep(500)

  // Bitails — last resort
  try {
    console.log(`   Trying Bitails...`)
    const r = await fetch(`https://api.bitails.io/address/${address}/unspent?limit=100&offset=0`)
    if (r.ok) {
      const data = await r.json()
      const rows = Array.isArray(data) ? data : (data?.unspent ?? data?.utxos ?? [])
      const large = rows
        .filter(u => (u.satoshis ?? u.value ?? 0) >= minSats)
        .map(u => ({
          transaction_hash: u.txid ?? u.tx_hash,
          index:            u.vout ?? u.tx_pos ?? u.n ?? 0,
          value:            u.satoshis ?? u.value,
        }))
      if (large.length > 0) { console.log(`   → Bitails: ${large.length} large UTXOs`); return large }
      console.log(`   → Bitails: 0 large UTXOs`)
    } else { console.log(`   → Bitails: HTTP ${r.status}`) }
  } catch (e) { console.log(`   → Bitails: ${e.message}`) }

  return []
}

async function broadcast(hex) {
  const [arcR, wocR] = await Promise.allSettled([
    fetch(ARC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawTx: hex }) })
      .then(r => r.text()).catch(e => e.message),
    fetch(`${WOC}/tx/raw`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txhex: hex }) })
      .then(r => r.text()).catch(e => e.message),
  ])
  const arc = arcR.value || ''
  const woc = wocR.value || ''
  const ok  = arc.includes('"SEEN_ON_NETWORK"') || arc.includes('"MINED"') || arc.includes('"txid"') || woc.length < 80
  return { arc, woc, ok }
}

// ── Load orchestrator ──────────────────────────────────────────────────────
const orchKey  = loadKey('.env.orchestrator')
const orchPriv = PrivateKey.fromHex(orchKey)
const orchAddr = orchPriv.toPublicKey().toAddress('mainnet').toString()

console.log(`\n🌙 Ensure Overnight — guaranteeing 20M sats per labeler`)
console.log(`   Orchestrator: ${orchAddr}\n`)

// ── Check orchestrator balance ─────────────────────────────────────────────
const orchBal = await wocGet(`/address/${orchAddr}/balance`)
const orchAvail = orchBal.confirmed + (orchBal.unconfirmed || 0)
console.log(`Orchestrator balance: ${orchAvail.toLocaleString()} sats`)
if (orchAvail < 5_000_000) {
  console.error('✗ Orchestrator has less than 5M sats — run recover-nexus.js first and wait for confirmation.')
  process.exit(1)
}

// ── Check each labeler ─────────────────────────────────────────────────────
const labelers = []
for (let n = 1; n <= 10; n++) {
  const file    = `.env.labeler${n}`
  const key     = loadKey(file)
  const priv    = PrivateKey.fromHex(key)
  const addr    = priv.toPublicKey().toAddress('mainnet').toString()

  await sleep(300)
  const bal   = await wocGet(`/address/${addr}/balance`)
  const total = bal.confirmed + (bal.unconfirmed || 0)

  // Detect dust UTXO problem: check if /unspent caps at 1000
  await sleep(300)
  let unspentCount = 0
  let unspentTotal = 0
  try {
    const utxos = await wocGet(`/address/${addr}/unspent`)
    unspentCount = utxos.length
    unspentTotal = utxos.reduce((s, u) => s + u.value, 0)
  } catch { /* ignore */ }

  const hasDustProblem = unspentCount >= DUST_THRESHOLD && unspentTotal < TARGET * 0.5

  labelers.push({ n, file, key, priv, addr, total, unspentCount, unspentTotal, hasDustProblem })

  const flag = hasDustProblem ? '⚠ DUST PROBLEM' : (total >= TARGET ? '✓' : '↑ NEEDS TOPUP')
  console.log(`  L${String(n).padStart(2)} ${addr}`)
  console.log(`      confirmed: ${total.toLocaleString().padStart(14)} sats  /unspent: ${unspentCount} UTXOs = ${unspentTotal.toLocaleString()} sats  ${flag}`)
}

// ── Handle dust-problem wallets first (fresh key + Blockchair sweep) ───────
const railwayUpdates = []

for (const w of labelers) {
  if (!w.hasDustProblem) continue

  console.log(`\n🔧 Fixing L${w.n} dust UTXO problem...`)

  // Find large UTXOs via Blockchair
  const largeUtxos = await findLargeUtxos(w.addr)
  if (largeUtxos.length === 0) {
    console.log(`   No large confirmed UTXOs found for L${w.n} — may still be unconfirmed. Skipping.`)
    continue
  }

  const sweepTotal = largeUtxos.reduce((s, u) => s + u.value, 0)
  console.log(`   Found ${largeUtxos.length} large UTXOs = ${sweepTotal.toLocaleString()} sats`)

  // Generate fresh key
  const newPriv = PrivateKey.fromRandom()
  const newKey  = newPriv.toHex()
  const newAddr = newPriv.toPublicKey().toAddress('mainnet').toString()
  console.log(`   New address: ${newAddr}`)

  // Build sweep tx from old → new address
  const oldScript = new P2PKH().lock(w.addr)
  const tx = new Transaction()
  for (const u of largeUtxos) {
    const stub = { outputs: [] }
    stub.outputs[u.index] = { satoshis: u.value }
    tx.addInput({
      sourceTXID:        u.transaction_hash,
      sourceOutputIndex: u.index,
      sequence:          0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(w.priv, 'all', false, u.value, oldScript),
    })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(newAddr), change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const { arc, woc, ok } = await broadcast(tx.toHex())
  const txid = tx.id('hex')
  console.log(`   ARC: ${arc.slice(0, 80)}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)

  if (ok) {
    // Update local .env file with new key
    updateEnvKey(w.file, newKey)
    // Update labeler object so topup goes to new address
    w.addr    = newAddr
    w.key     = newKey
    w.priv    = newPriv
    w.total   = tx.outputs[0]?.satoshis ?? 0
    w.hasDustProblem = false

    railwayUpdates.push({ n: w.n, newKey })
    console.log(`   ✅ Swept ${sweepTotal.toLocaleString()} sats to fresh address. .env.labeler${w.n} updated.`)
  } else {
    console.log(`   ⚠ Broadcast unclear — check WoC link. Skipping key rotation for L${w.n}.`)
  }
  await sleep(500)
}

// ── Build one topup tx from orchestrator to all under-funded labelers ──────
const needTopup = labelers.filter(w => w.total < TARGET)
if (needTopup.length === 0) {
  console.log('\n✅ All labelers already at 20M+ sats. Ready to restart.')
} else {
  console.log(`\n💸 Topping up ${needTopup.length} labelers from orchestrator...`)

  // Fetch orchestrator UTXOs
  await sleep(500)
  let orchUtxos = await wocGet(`/address/${orchAddr}/unspent`)
  orchUtxos = orchUtxos.sort((a, b) => b.value - a.value)

  const orchVisible = orchUtxos.reduce((s,u)=>s+u.value,0)
  const totalNeeded = needTopup.reduce((s, w) => s + (TARGET - w.total), 0)
  console.log(`   Need: ${totalNeeded.toLocaleString()} sats  |  Available in /unspent: ${orchVisible.toLocaleString()} sats`)

  const orchBudget = orchVisible - 300_000  // keep 300k in orchestrator
  if (orchBudget <= 0) {
    console.error('   ✗ No orchestrator UTXOs visible — check chain confirmation and retry.')
    process.exit(1)
  }

  // Scale down proportionally if orchestrator can't fully fund everyone
  const topupAmts = new Map()
  if (orchBudget < totalNeeded) {
    console.log(`   ⚠ Orchestrator short by ${(totalNeeded - orchBudget).toLocaleString()} sats — scaling proportionally`)
    const scale = orchBudget / totalNeeded
    for (const w of needTopup) topupAmts.set(w.n, Math.floor((TARGET - w.total) * scale))
  } else {
    for (const w of needTopup) topupAmts.set(w.n, TARGET - w.total)
  }

  // Select enough orchestrator UTXOs
  const actualNeeded = [...topupAmts.values()].reduce((s,v)=>s+v,0)
  const selected = []
  let inputTotal = 0
  for (const u of orchUtxos) {
    selected.push(u)
    inputTotal += u.value
    if (inputTotal >= actualNeeded + 200_000) break
  }

  const orchScript = new P2PKH().lock(orchAddr)
  const tx = new Transaction()

  for (const u of selected) {
    const stub = { outputs: [] }
    stub.outputs[u.tx_pos] = { satoshis: u.value }
    tx.addInput({
      sourceTXID:        u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      sequence:          0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(orchPriv, 'all', false, u.value, orchScript),
    })
  }

  for (const w of needTopup) {
    const topupAmt = topupAmts.get(w.n)
    tx.addOutput({ lockingScript: new P2PKH().lock(w.addr), satoshis: topupAmt })
    console.log(`   L${w.n}: +${topupAmt.toLocaleString()} sats → ${w.addr}`)
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(orchAddr), change: true })

  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const hex  = tx.toHex()
  const txid = tx.id('hex')
  const fee  = inputTotal - tx.outputs.reduce((s, o) => s + o.satoshis, 0)
  console.log(`\n   txid: ${txid}`)
  console.log(`   fee:  ${fee} sats`)

  const { arc, woc, ok } = await broadcast(hex)
  console.log(`   ARC: ${arc.slice(0, 100)}`)
  console.log(`   WoC: ${woc.slice(0, 100)}`)
  console.log(`   https://whatsonchain.com/tx/${txid}`)

  if (ok) {
    console.log(`\n✅ Topup broadcast successful!`)
  } else {
    console.log(`\n⚠ Check WoC link above before restarting.`)
  }
}

// ── Print Railway update instructions if any keys changed ─────────────────
if (railwayUpdates.length > 0) {
  console.log('\n' + '═'.repeat(60))
  console.log('⚠  RAILWAY ENV VAR UPDATE REQUIRED BEFORE RESTART')
  console.log('═'.repeat(60))
  console.log('Go to Railway → your service → Variables and update:')
  console.log()
  for (const { n, newKey } of railwayUpdates) {
    console.log(`  Labeler-${n}  AGENT_KEY = ${newKey}`)
  }
  console.log()
  console.log('Update these BEFORE restarting the service, then restart.')
  console.log('═'.repeat(60))
} else {
  console.log('\n⏳ Wait for the topup to confirm (~10 min), then restart the Railway service.')
  console.log('   All labelers will start with 20M+ sats on fresh confirmed UTXOs.')
  console.log('   Sleep well. 🌙')
}
