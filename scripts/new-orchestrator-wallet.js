/**
 * scripts/new-orchestrator-wallet.js
 * Generates a fresh orchestrator wallet, funds it from the richest labeler,
 * and writes the new key to .env.orchestrator.
 *
 * Usage:
 *   node scripts/new-orchestrator-wallet.js
 *
 * This is needed when the old orchestrator address has accumulated so many
 * dust UTXOs that WoC's 1000-UTXO API cap hides the real funded UTXOs.
 */
import { PrivateKey, P2PKH, Transaction, SatoshisPerKilobyte } from '@bsv/sdk'
import { readFileSync, writeFileSync, existsSync } from 'fs'

const WOC = 'https://api.whatsonchain.com/v1/bsv/main'
const ARC = 'https://arc.gorillapool.io/v1/tx'
const FEE_RATE = 200
const FUND_AMOUNT = 15_000_000  // 0.15 BSV to new orchestrator (needs ~8M for 24h, 15M = safe headroom)

const LABELER_ENV_FILES = [
  '.env.labeler8', '.env.labeler6', '.env.labeler7', '.env.labeler4',
  '.env.labeler5', '.env.labeler3', '.env.labeler2', '.env.labeler10',
  '.env.labeler9', '.env.labeler1',
]

function loadEnv(path) {
  try {
    const content = readFileSync(path, 'utf8')
    const env = {}
    for (const line of content.split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    return env
  } catch { return null }
}

async function getBalance(address) {
  try {
    const r = await fetch(`${WOC}/address/${address}/balance`)
    if (!r.ok) return 0
    const { confirmed } = await r.json()
    return confirmed || 0
  } catch { return 0 }
}

async function getUtxos(address) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(`${WOC}/address/${address}/unspent`)
    if (r.ok) return r.json()
    if (r.status === 429) {
      await new Promise(res => setTimeout(res, attempt * 2000))
      continue
    }
    throw new Error(`WoC fetch failed: ${r.status}`)
  }
  throw new Error('WoC rate limited after 5 retries')
}

// ── Step 1: Generate new orchestrator key ─────────────────────────────────────

console.log('\n🔑 Generating new orchestrator wallet...')
const newPriv    = PrivateKey.fromRandom()
const newKeyHex  = newPriv.toHex()
const newAddress = newPriv.toPublicKey().toAddress('mainnet').toString()
console.log(`   New address: ${newAddress}`)
console.log(`   New key:     ${newKeyHex.slice(0, 16)}...`)

// ── Step 2: Find richest labeler to fund from ─────────────────────────────────

console.log('\n🔍 Finding richest labeler to fund from...')
let bestEnv = null, bestBal = 0, bestFile = null

for (const file of LABELER_ENV_FILES) {
  const env = loadEnv(file)
  if (!env?.AGENT_KEY) continue
  const priv = PrivateKey.fromHex(env.AGENT_KEY)
  const addr = priv.toPublicKey().toAddress('mainnet').toString()
  const bal  = await getBalance(addr)
  console.log(`   ${file}: ${bal.toLocaleString()} sats`)
  if (bal > bestBal) { bestBal = bal; bestEnv = env; bestFile = file }
  await new Promise(r => setTimeout(r, 300))  // rate limit courtesy
}

if (!bestEnv || bestBal < FUND_AMOUNT + 10_000) {
  console.error(`\n✗ No labeler has enough funds (need ${(FUND_AMOUNT + 10_000).toLocaleString()} sats)`)
  console.error(`  Best: ${bestFile} with ${bestBal.toLocaleString()} sats`)
  process.exit(1)
}

console.log(`\n   Funding from: ${bestFile} (${bestBal.toLocaleString()} sats)`)

// ── Step 3: Send FUND_AMOUNT to new orchestrator address ──────────────────────

const srcPriv    = PrivateKey.fromHex(bestEnv.AGENT_KEY)
const srcAddress = srcPriv.toPublicKey().toAddress('mainnet').toString()
const myScript   = new P2PKH().lock(srcAddress)

console.log(`\n💸 Building funding tx: ${FUND_AMOUNT.toLocaleString()} sats → ${newAddress}`)

const utxos = await getUtxos(srcAddress)
const usable = utxos.sort((a, b) => b.value - a.value)

const selected = []
let total = 0
for (const u of usable) {
  selected.push(u)
  total += u.value
  if (total >= FUND_AMOUNT + 10_000) break
}
console.log(`   Selected ${selected.length} UTXOs (${total.toLocaleString()} sats)`)

const tx = new Transaction()
for (const u of selected) {
  const stub = { outputs: [] }
  stub.outputs[u.tx_pos] = { satoshis: u.value }
  tx.addInput({
    sourceTXID: u.tx_hash,
    sourceOutputIndex: u.tx_pos,
    sequence: 0xffffffff,
    sourceTransaction: stub,
    unlockingScriptTemplate: new P2PKH().unlock(srcPriv, 'all', false, u.value, myScript),
  })
}
tx.addOutput({ lockingScript: new P2PKH().lock(newAddress), satoshis: FUND_AMOUNT })
tx.addOutput({ lockingScript: new P2PKH().lock(srcAddress), change: true })

await tx.fee(new SatoshisPerKilobyte(FEE_RATE))
await tx.sign()

const hex  = tx.toHex()
const txid = tx.id('hex')
const fee  = total - FUND_AMOUNT - (tx.outputs[1]?.satoshis ?? 0)
console.log(`   txid: ${txid}  fee: ${fee} sats`)

// ── Step 4: Broadcast ─────────────────────────────────────────────────────────

console.log('\n📡 Broadcasting...')
const [arcRes, wocRes] = await Promise.allSettled([
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

const arc = arcRes.value
const woc = wocRes.value
console.log(`   ARC: ${arc.body?.slice(0, 100)}`)
console.log(`   WoC: ${woc.body?.slice(0, 100)}`)

const success = arc.body?.includes('"SEEN_ON_NETWORK"') || arc.body?.includes('"MINED"') ||
                arc.body?.includes('"txid"') || woc.body?.length < 80

// ── Step 5: Write new .env.orchestrator ───────────────────────────────────────

const envPath = '.env.orchestrator'
const oldContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''

// Back up old key as comment
const newContent = oldContent
  .split('\n')
  .map(line => line.trim().startsWith('AGENT_KEY=') ? `# OLD: ${line}\nAGENT_KEY=${newKeyHex}` : line)
  .join('\n')

writeFileSync(envPath, newContent, 'utf8')
const newPubKey = newPriv.toPublicKey().toString()

console.log(`\n✅ .env.orchestrator updated with new key`)

if (success) {
  console.log(`\n✅ Funding tx broadcast successful!`)
} else {
  console.log(`\n⚠ Broadcast status unclear — check:`)
}
console.log(`   https://whatsonchain.com/tx/${txid}`)

console.log(`\n${'═'.repeat(60)}`)
console.log(`NEW ORCHESTRATOR WALLET`)
console.log(`  Address:    ${newAddress}`)
console.log(`  Funded:     ${FUND_AMOUNT.toLocaleString()} sats`)
console.log(`${'═'.repeat(60)}`)
console.log(`\nRAILWAY ENV VARS TO UPDATE:`)
console.log(``)
console.log(`  orchestrator service:`)
console.log(`    AGENT_KEY = ${newKeyHex}`)
console.log(``)
console.log(`  ALL 10 labeler services (labeler-1 through labeler-10):`)
console.log(`    ORCHESTRATOR_KEY = ${newPubKey}`)
console.log(``)
console.log(`  (ORCHESTRATOR_KEY is the orchestrator's public key — labelers use it`)
console.log(`   to route registration and job messages through the relay)`)
console.log(`${'═'.repeat(60)}`)
console.log(`\nSteps:`)
console.log(`  1. Wait ~30s for funding tx to propagate`)
console.log(`  2. Update Railway env vars above`)
console.log(`  3. Redeploy + restart all agents`)
console.log()
