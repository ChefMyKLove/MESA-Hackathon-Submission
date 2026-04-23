/**
 * scripts/fund-from-gen2.js
 *
 * Sweeps each gen2 wallet's full balance directly to its gen3 counterpart.
 * Gen1 (18xNrXZ...) has 285k dust UTXOs that can't be spent easily — skip it.
 * Gen2 wallets have normal UTXOs and 235M sats total, which is enough:
 *   - Each labeler needs ~13.8M sats for a full 24h run (distribute.js uses 24.5M)
 *   - Gen2 labelers have 14.7M–49.9M each — all sufficient
 *   - Gen2 orchestrator has 36.3M — more than enough for gen3 orchestrator
 *
 * Usage: node scripts/fund-from-gen2.js
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync } from 'fs'

const FEE_RATE = 500  // sat/KB
const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC      = 'https://arc.gorillapool.io/v1/tx'
const BSV_PRICE = 40
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Gen2 source keys → gen3 .env destination files ───────────────────────────

const PAIRS = [
  { srcKey: 'a02a7a95b0bf005227909d68e7ae65febdb6b57c4621e558593f2f8c0e95e1af', srcLabel: 'prev-orch (gen2)', dstFile: '.env.orchestrator', dstLabel: 'NEXUS (gen3)' },
  { srcKey: '98e68af864aca7b3307abe1a0fc135f12687a2368cf216cfcac0af9913643503', srcLabel: 'prev-L1   (gen2)', dstFile: '.env.labeler1',     dstLabel: 'ARIA  (gen3)' },
  { srcKey: '7d29b0a3079659c9933e590d7e6253f62ad61ebea78e073c70930b7ed43e9eb2', srcLabel: 'prev-L2   (gen2)', dstFile: '.env.labeler2',     dstLabel: 'BOLT  (gen3)' },
  { srcKey: '4ccab8efa2ba36ec0d23db75563c7c14127d2f5015879efd5e2b07ba81e1c762', srcLabel: 'prev-L3   (gen2)', dstFile: '.env.labeler3',     dstLabel: 'CIPHER(gen3)' },
  { srcKey: 'f2d03b4eed91476e49aee5255a96e9e8db0e508d6141ec6fa60904875482a9e2', srcLabel: 'prev-L4   (gen2)', dstFile: '.env.labeler4',     dstLabel: 'DELTA (gen3)' },
  { srcKey: 'c3abbf385b20a9027d368ccedc8b507338ed9d9f4a73e109d71919d56bd6358a', srcLabel: 'prev-L5   (gen2)', dstFile: '.env.labeler5',     dstLabel: 'ECHO  (gen3)' },
  { srcKey: 'a38efb923cc3f7b22da3b93d8563a3dddadfa41b59e76031c646a7209adf63b4', srcLabel: 'prev-L6   (gen2)', dstFile: '.env.labeler6',     dstLabel: 'FLUX  (gen3)' },
  { srcKey: 'edb245cac0ac32a8ae07b8e1efc487f0614262907b8d9066455cb95906e58b36', srcLabel: 'prev-L7   (gen2)', dstFile: '.env.labeler7',     dstLabel: 'GRAPH (gen3)' },
  { srcKey: '80be8ac5e96ed7414bf2fe5b206511e23f87b6613484de22f334b9a7534517d8', srcLabel: 'prev-L8   (gen2)', dstFile: '.env.labeler8',     dstLabel: 'HELIX (gen3)' },
  { srcKey: 'f135c4c3a274b25e45186a3517d51bbe510f6d09042b6f88719381165bb3ba64', srcLabel: 'prev-L9   (gen2)', dstFile: '.env.labeler9',     dstLabel: 'IRIS  (gen3)' },
  { srcKey: 'f98954cf2628d0fd3814af7637ac9d8761f45853140cb7b8eb994d85a1d0d61e', srcLabel: 'prev-L10  (gen2)', dstFile: '.env.labeler10',    dstLabel: 'JADE  (gen3)' },
]

function loadDstAddress(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) {
        const hex = t.slice('AGENT_KEY='.length).trim()
        if (hex.length === 64) return PrivateKey.fromHex(hex).toPublicKey().toAddress('mainnet').toString()
      }
    }
  } catch {}
  return null
}

async function getUtxos(address) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${WOC}/address/${address}/unspent`, { signal: AbortSignal.timeout(20_000) })
      if (r.ok) return await r.json()
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue }
    } catch {}
  }
  return []
}

async function sweepToAddress(srcKey, srcLabel, dstAddr, dstLabel) {
  const priv     = PrivateKey.fromHex(srcKey)
  const srcAddr  = priv.toPublicKey().toAddress('mainnet').toString()
  const myScript = new P2PKH().lock(srcAddr)

  process.stdout.write(`  ${srcLabel} → ${dstLabel}... fetching UTXOs... `)
  const utxos    = await getUtxos(srcAddr)
  const spendable = utxos.filter(u => u.value > 0)
  const totalIn  = spendable.reduce((s, u) => s + u.value, 0)

  if (spendable.length === 0 || totalIn < 5_000) {
    console.log(`skipped (${totalIn} sats — too low)`)
    return 0
  }

  const tx = new Transaction()
  for (const u of spendable) {
    const stub = { outputs: [] }
    stub.outputs[u.tx_pos] = { satoshis: u.value }
    tx.addInput({
      sourceTXID: u.tx_hash, sourceOutputIndex: u.tx_pos, sequence: 0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(priv, 'all', false, u.value, myScript),
    })
  }
  tx.addOutput({ lockingScript: new P2PKH().lock(dstAddr), change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const outSats = tx.outputs[0]?.satoshis ?? 0
  const fee     = totalIn - outSats

  if (outSats <= 0) {
    console.log(`skipped (dust after fee)`)
    return 0
  }

  const hex = tx.toHex()

  // Try ARC first, then WoC
  let ok = false
  try {
    const r = await fetch(ARC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
      body: JSON.stringify({ rawTx: hex }),
      signal: AbortSignal.timeout(45_000),
    })
    const body = await r.text()
    ok = r.ok || body.includes('already') || body.includes('txn-already')
    if (!ok) console.log(`\n    ARC ${r.status}: ${body.slice(0, 100)}`)
  } catch (e) { console.log(`\n    ARC error: ${e.message}`) }

  if (!ok) {
    try {
      const r = await fetch(`${WOC}/tx/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: hex }),
        signal: AbortSignal.timeout(20_000),
      })
      ok = r.ok || (await r.text()).includes('already')
    } catch {}
  }

  if (ok) {
    console.log(`✓  ${outSats.toLocaleString()} sats  (fee: ${fee})  ${tx.id('hex').slice(0, 20)}…`)
    return outSats
  } else {
    console.log(`✗  broadcast failed`)
    return 0
  }
}

async function main() {
  console.log('\n💸 Fund Gen3 Wallets — sweep gen2 → gen3')
  console.log('═'.repeat(65))
  console.log('  Each gen2 wallet sweeps its full balance to the matching gen3 wallet.\n')

  // Resolve all destination addresses first
  const pairs = []
  for (const p of PAIRS) {
    const dstAddr = loadDstAddress(p.dstFile)
    if (!dstAddr) { console.error(`  ✗ Cannot read address from ${p.dstFile}`); process.exit(1) }
    pairs.push({ ...p, dstAddr })
    console.log(`  ${p.srcLabel}  →  ${p.dstLabel}  (${dstAddr})`)
  }

  console.log('\n' + '─'.repeat(65))

  let totalSwept = 0
  let succeeded  = 0

  for (const p of pairs) {
    const swept = await sweepToAddress(p.srcKey, p.srcLabel, p.dstAddr, p.dstLabel)
    totalSwept += swept
    if (swept > 0) succeeded++
    await sleep(1_500)
  }

  console.log('─'.repeat(65))
  console.log(`\n  ✅ Swept ${succeeded}/${pairs.length} wallets`)
  console.log(`  Total moved: ${totalSwept.toLocaleString()} sats  (${(totalSwept / 1e8).toFixed(4)} BSV ≈ $${(totalSwept / 1e8 * BSV_PRICE).toFixed(2)})`)
  console.log('\n  Next steps:')
  console.log('    node scripts/balance-all.js   — verify gen3 wallets received funds')
  console.log('    node scripts/fanout.js        — split UTXOs for high-frequency use')
  console.log('    npm start                     — launch full 24h run\n')
}

main().catch(err => {
  console.error('\nFatal:', err.message)
  process.exit(1)
})
