/**
 * scripts/collect-all.js
 *
 * Sweeps ALL current agent wallets (orchestrator + 10 labelers) to a single
 * target address in preparation for re-keying.
 *
 * Usage:
 *   node scripts/collect-all.js --to <destination_address>
 *
 * Example (sweep everything to the new orchestrator address):
 *   node scripts/collect-all.js --to 1NewOrchestratorAddressHere
 *
 * Run BEFORE updating .env files with new keys.
 * Run AFTER any in-flight txs have confirmed (agents stopped).
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync } from 'fs'

const TO_IDX = process.argv.indexOf('--to')
const DST    = TO_IDX >= 0 ? process.argv[TO_IDX + 1] : null

if (!DST) {
  console.error('Usage: node scripts/collect-all.js --to <destination_address>')
  process.exit(1)
}

const ENV_FILES = [
  '.env.orchestrator',
  '.env.labeler1',  '.env.labeler2',  '.env.labeler3',  '.env.labeler4',  '.env.labeler5',
  '.env.labeler6',  '.env.labeler7',  '.env.labeler8',  '.env.labeler9',  '.env.labeler10',
]

const WOC      = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC      = 'https://arc.gorillapool.io/v1/tx'
const FEE_RATE = 500  // sat/KB

const sleep = ms => new Promise(r => setTimeout(r, ms))

function loadKey(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (t.startsWith('AGENT_KEY=')) return t.slice('AGENT_KEY='.length).trim()
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

async function sweep(privKey, address, label) {
  const utxos = await getUtxos(address)
  const spendable = utxos.filter(u => u.value > 0)

  if (spendable.length === 0) {
    console.log(`  ${label.padEnd(14)} — empty, skipping`)
    return 0
  }

  const myScript = new P2PKH().lock(address)
  const tx = new Transaction()
  const totalIn = spendable.reduce((s, u) => s + u.value, 0)

  for (const u of spendable) {
    const stub = { outputs: [] }
    stub.outputs[u.tx_pos] = { satoshis: u.value }
    tx.addInput({
      sourceTXID:        u.tx_hash,
      sourceOutputIndex: u.tx_pos,
      sequence:          0xffffffff,
      sourceTransaction: stub,
      unlockingScriptTemplate: new P2PKH().unlock(privKey, 'all', false, u.value, myScript),
    })
  }

  tx.addOutput({ lockingScript: new P2PKH().lock(DST), change: true })
  await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
  await tx.sign()

  const hex     = tx.toHex()
  const txid    = tx.id('hex')
  const outSats = tx.outputs[0]?.satoshis ?? 0
  const fee     = totalIn - outSats

  if (outSats <= 0) {
    console.log(`  ${label.padEnd(14)} — dust only (${totalIn} sats < fee), skipping`)
    return 0
  }

  // Try ARC then WoC
  let ok = false
  try {
    const r = await fetch(ARC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-WaitFor': 'STORED' },
      body: JSON.stringify({ rawTx: hex }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await r.text()
    ok = r.ok || body.includes('already') || body.includes('txn-already-in-mempool')
    if (!ok) console.log(`\n    ARC ${r.status}: ${body.slice(0, 80)}`)
  } catch (e) {
    console.log(`\n    ARC error: ${e.message}`)
  }

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

  const status = ok ? '✓' : '✗'
  console.log(`  ${status} ${label.padEnd(14)} ${utxos.length} UTXOs  ${outSats.toLocaleString().padStart(14)} sats  fee=${fee}  ${txid.slice(0, 20)}…`)
  return ok ? outSats : 0
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n🧹 Collect All — sweeping ${ENV_FILES.length} wallets → ${DST}\n`)

let totalSwept = 0

for (const file of ENV_FILES) {
  const keyHex = loadKey(file)
  if (!keyHex) {
    console.log(`  ${'?'.padEnd(14)} ${file} — no AGENT_KEY found`)
    continue
  }

  const priv    = PrivateKey.fromHex(keyHex)
  const address = priv.toPublicKey().toAddress('mainnet').toString()
  const label   = file.replace('.env.', '')

  const swept = await sweep(priv, address, label)
  totalSwept += swept
  await sleep(600)
}

console.log(`\n  Total swept: ${totalSwept.toLocaleString()} sats (${(totalSwept / 1e8).toFixed(6)} BSV)`)
console.log(`  Destination: ${DST}`)
console.log()
console.log('  Next steps:')
console.log('    1. Wait for next BSV block to confirm')
console.log('    2. Update all .env files with new keys from keygen.js output')
console.log('    3. FUNDING_KEY=<new_orch_key> node scripts/distribute.js')
console.log('    4. node scripts/fanout.js  (split UTXOs for high-freq use)')
console.log('    5. npm start\n')
