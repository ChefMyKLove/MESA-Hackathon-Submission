/**
 * labeler.js — MESA Labeler Specialist Agent
 *
 * Run multiple instances in parallel to hit transaction throughput target.
 * Each instance is independent with its own BSV wallet and identity.
 *
 * Per task cycle (this agent's contribution):
 *   1. Receives job via MessageBox
 *   2. Submits bid: 1-sat BSV tx to orchestrator with OP_RETURN bid data  ← on-chain tx
 *   3. If awarded: labels text using DistilBERT ML inference (10–50ms, local, no API)
 *   4. Inscribes result: BSV tx with OP_RETURN label data                  ← on-chain tx
 *   5. Receives payment from orchestrator (orchestrator-side tx)           ← on-chain tx
 *
 * Usage:
 *   node --env-file=.env.labeler1 agents/labeler.js
 *   node --env-file=.env.labeler2 agents/labeler.js
 *   ... (run 10 instances with different .env files)
 */
import { MesaAgent } from './base.js'
import {
  BOXES, MSG, SATS,
  mkRegister, mkBid, mkResult, parseBody,
  opReturnBid, opReturnResult,
} from '../shared/protocol.js'
import { BsvWallet, addressFromPrivKey } from '../shared/bsv.js'
import { relay } from '../shared/relay.js'
import { mlLabel, initMLClassifier } from '../data/loader.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const ORCHESTRATOR_KEY = process.env.ORCHESTRATOR_KEY
if (!ORCHESTRATOR_KEY) throw new Error('ORCHESTRATOR_KEY not set in env file')

const INSTANCE_ID = process.env.INSTANCE_ID || '1'

// ── Boot ─────────────────────────────────────────────────────────────────────

const agent   = new MesaAgent(process.env.AGENT_NAME || `labeler-${INSTANCE_ID}`)
const wallet  = new BsvWallet(process.env.AGENT_KEY)

// Load DistilBERT ML model FIRST — runs locally, no API. All 10 instances share
// the same on-disk cache so the 67MB download only happens once ever.
// Loading before the relay connection means the model is warm and ready the
// instant the first award arrives — no inference delay on the first task won.
await initMLClassifier(msg => console.log(`[LABELER-${INSTANCE_ID}] ${msg}`))

// Stagger startup: 2s base so relay is ready + per-instance offset to avoid WoC rate limits
await sleep(2000 + parseInt(INSTANCE_ID) * 800)

await agent.init()
await wallet.refreshUtxos(true)
await wallet.warmCache()  // pre-fetch source txs so send() never hits WoC mid-bid

agent.log(`Online | address: ${wallet.address_str}`)
agent.log(`Wallet balance: ${wallet.balance()} sats`)

if (wallet.balance() < 5_000) {
  agent.log(`⚠ LOW BALANCE: ${wallet.balance()} sats`)
  agent.log(`  Fund this address: ${wallet.address_str}`)
  agent.log(`  Need at least 20,000 sats for a full 24h run (covers ~13,600 bid txs @ 1 sat + fees)`)
}

// Stats
let bidsSubmitted  = 0
let tasksCompleted = 0
let txOnChain      = 0
let startTime      = Date.now()

// 4 parallel wallet queues — each queue is an independent UTXO chain.
// send() now awaits broadcast (~300-500ms), so parallelism is essential for throughput.
// 4 queues × ~2 tx/sec per queue = ~8 confirmed on-chain tx/sec per labeler instance.
const NUM_WALLET_QUEUES = 4
const _walletQueues = Array.from({ length: NUM_WALLET_QUEUES }, () => Promise.resolve())
let _walletQueueIdx = 0

function walletSend(outputs, opReturn) {
  let resolve, reject
  const p = new Promise((res, rej) => { resolve = res; reject = rej })
  const i = _walletQueueIdx % NUM_WALLET_QUEUES
  _walletQueueIdx++
  _walletQueues[i] = _walletQueues[i].then(async () => {
    try   { resolve(await wallet.send(outputs, opReturn)) }
    catch (err) { reject(err) }
  }).catch(() => {})
  return p
}

// ── Register with orchestrator ────────────────────────────────────────────────

async function register() {
  const msg = mkRegister({ agentKey: agent.identityKey, bidAddress: wallet.address_str })
  await agent.send(ORCHESTRATOR_KEY, BOXES.REGISTRATIONS, msg)
  agent.log(`Registered with orchestrator`)
}

// Register immediately, then retry every 10s for the first minute
// (orchestrator may not be in the relay routing table yet on first connect)
await register()
let _regAttempts = 0
const _regInterval = setInterval(async () => {
  _regAttempts++
  await register()
  if (_regAttempts >= 6) clearInterval(_regInterval)  // stop after 6 retries (1 min)
}, 10_000)
setInterval(register, 5 * 60_000)  // heartbeat every 5min after that

// ── Listen for job postings ───────────────────────────────────────────────────

agent.listen(BOXES.JOB_POSTINGS, async ({ sender, body }) => {
  if (body.t !== MSG.JOB) return

  const taskId = body.id
  const text   = body.tx

  // ① Send relay bid message immediately so orchestrator knows we're competing.
  //   bidTxid will be updated once the on-chain tx confirms (below).
  const bidMsg = mkBid({ taskId, agentKey: agent.identityKey, bidTxid: 'pending' })
  await agent.send(sender, BOXES.BIDS, bidMsg)
  bidsSubmitted++

  // ② Enqueue on-chain bid tx — awaits confirmed broadcast before counting.
  //   Relay event fires only after ARC confirms storage, so UI count = real on-chain count.
  ;(async () => {
    try {
      const bidTxid = await walletSend([], opReturnBid(taskId, agent.identityKey))
      txOnChain++
      relay.bidReceived(taskId, taskId, agent.identityKey, `labeler-${INSTANCE_ID}`, SATS.BID_DEPOSIT)
      if (txOnChain <= 3) agent.log(`⛓ BID TX #${txOnChain}: https://whatsonchain.com/tx/${bidTxid}`)
    } catch (err) {
      agent.log(`⚠ Bid tx failed for ${taskId}: ${err.message}`)
    }
  })()
})

// ── Listen for awards (we won!) ───────────────────────────────────────────────

agent.listen(BOXES.AWARDS, async ({ sender, body }) => {
  if (body.t !== MSG.AWARD) return

  const taskId = body.id
  const text   = body.tx

  relay.workStarted(taskId, taskId, agent.identityKey, `labeler-${INSTANCE_ID}`)

  // Label the text — real DistilBERT ML inference (10–50ms), falls back to
  // rule-based if the model isn't ready. Runs locally, no API call.
  const { label, confidence } = await mlLabel(text)

  // Send result to orchestrator immediately — payment must not wait for inscription.
  // The inscription is on-chain proof but the orchestrator pays on result receipt.
  const resultMsg = mkResult({
    taskId,
    agentKey: agent.identityKey,
    label,
    confidence,
    resultTxid: 'pending',  // filled in async below
  })

  await agent.send(sender, BOXES.RESULTS, resultMsg)
  tasksCompleted++

  // Inscribe result on-chain — relay event fires only after confirmed broadcast.
  // No artificial delay needed: send() now awaits ARC confirmation, so the bid tx
  // (queued before this) is already stored in ARC by the time we get here.
  ;(async () => {
    try {
      const inscTxid = await walletSend(
        [],
        opReturnResult(taskId, agent.identityKey, label, confidence.toFixed(2))
      )
      txOnChain++
      relay.resultDelivered(taskId, taskId, agent.identityKey, `labeler-${INSTANCE_ID}`, `${label} (${Math.round(confidence * 100)}%)`)
      agent.log(`⛓ INSCRIPTION: https://whatsonchain.com/tx/${inscTxid}`)
    } catch (err) {
      agent.log(`⚠ Result inscription failed for ${taskId}: ${err.message}`)
    }
  })()
})

// ── Orchestrator address cache ────────────────────────────────────────────────
// We derive the orchestrator's BSV address from their public key so we can
// send 1-sat bid deposits to them.

let _orchAddress = null

async function getOrchestratorAddress() {
  if (_orchAddress) return _orchAddress
  try {
    // ORCHESTRATOR_KEY is the orchestrator's compressed PUBLIC key (66 hex chars, 02/03 prefix).
    // addressFromPrivKey detects the 02/03 prefix and derives the address correctly.
    _orchAddress = addressFromPrivKey(process.env.ORCHESTRATOR_KEY)
  } catch (err) {
    agent.log(`⚠ Could not derive orchestrator address from ORCHESTRATOR_KEY: ${err.message}`)
    _orchAddress = process.env.ORCHESTRATOR_ADDRESS || null
  }
  if (!_orchAddress) {
    agent.log(`⚠ Orchestrator address unavailable — bid deposits disabled. Set ORCHESTRATOR_ADDRESS in env.`)
  }
  return _orchAddress
}

// ── Stats logger ──────────────────────────────────────────────────────────────

setInterval(() => {
  const elapsed   = (Date.now() - startTime) / 1000
  const txPerSec  = (txOnChain / elapsed).toFixed(2)
  const stats = `bids: ${bidsSubmitted} | done: ${tasksCompleted} | on-chain: ${txOnChain} | ${txPerSec} tx/s | bal: ${wallet.balance()}`
  agent.log(`📊 ${stats}`)
  relay.log(`labeler-${INSTANCE_ID}`, stats)
}, 15_000)

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  relay.agentOffline(agent.identityKey, `labeler-${INSTANCE_ID}`)
  process.exit(0)
})
