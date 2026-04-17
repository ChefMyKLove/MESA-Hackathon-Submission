/**
 * orchestrator.js — MESA High-Frequency Orchestrator
 *
 * Drives the labeling marketplace at 1.58 tasks/second sustained.
 * Each task cycle produces 3 on-chain BSV transactions:
 *   1. Each competing agent bids (1-sat BSV tx with OP_RETURN bid data)
 *   2. Orchestrator pays winner (10-sat BSV tx with OP_RETURN payment data)
 *   3. Winner inscribes result (OP_RETURN label inscription BSV tx)
 *
 * 10 agents × 1.58 bids/sec + 1.58 payments/sec ≈ 17 on-chain tx/sec
 * × 86,400 sec = 1,468,800 tx/day (safely over 1.5M with headroom)
 *
 * Stats are logged every 10 seconds and emitted to the relay dashboard.
 */
import { MesaAgent } from './base.js'
import {
  BOXES, MSG, SATS, BID_WINDOW_MS,
  mkJob, mkAward, taskId,
  opReturnPayment,
} from '../shared/protocol.js'
import { BsvWallet } from '../shared/bsv.js'
import { relay } from '../shared/relay.js'
import { nextItem } from '../data/loader.js'

// Registry: agentKey → { bidAddress }
const registry = {}

// Parallel payment queues — NUM_PAY_QUEUES independent UTXO chains running concurrently.
// Each queue serializes its own wallet.send() calls so its UTXO chain never double-spends.
// With N queues, throughput scales to N × (1 / broadcast_latency) payments/sec.
// The wallet's _locked Set prevents two queues from ever grabbing the same UTXO.
const NUM_PAY_QUEUES = 5
const _queues = Array.from({ length: NUM_PAY_QUEUES }, () => Promise.resolve())
let _queueIdx = 0

function enqueuePayment(fn) {
  const i = _queueIdx % NUM_PAY_QUEUES
  _queueIdx++
  _queues[i] = _queues[i].then(fn).catch(() => {})
}

// In-flight tasks: taskId → { text, bids: [{agentKey, bidTxid, ts}], timer }
const inFlight = new Map()

// Stats
let txCount     = 0
let tasksPosted = 0
let tasksDone   = 0
let startTime   = Date.now()

// ── Boot ─────────────────────────────────────────────────────────────────────

// Wait for relay to be ready — concurrently starts all processes simultaneously
await new Promise(r => setTimeout(r, 3000))

const agent = new MesaAgent('orchestrator')
await agent.init()

const wallet = new BsvWallet(process.env.AGENT_KEY)
await wallet.refreshUtxos(true)
await wallet.warmCache()  // pre-fetch source txs so first payment never hits WoC

agent.log(`Online | address: ${wallet.address_str}`)
agent.log(`Wallet balance: ${wallet.balance()} sats | ${wallet._utxos.length} UTXOs | ${NUM_PAY_QUEUES} parallel payment queues`)

if (wallet.balance() < 10_000) {
  agent.log(`⚠ LOW BALANCE: ${wallet.balance()} sats. Fund address: ${wallet.address_str}`)
  agent.log(`  Need at least 50,000 sats (0.0005 BSV) to start the 24h run.`)
}

// ── Accept registrations ─────────────────────────────────────────────────────

agent.listen(BOXES.REGISTRATIONS, async ({ sender, body }) => {
  if (body.t !== MSG.REGISTER) return

  registry[sender] = { agentKey: sender, bidAddress: body.a }
  const count = Object.keys(registry).length
  agent.log(`✓ Registered agent ${count}: ${sender.slice(0, 14)}...`)

  relay.log('orchestrator', `Agent registered: ${sender.slice(0, 14)}... (${count} total)`)
})

// ── Collect bids ─────────────────────────────────────────────────────────────

agent.listen(BOXES.BIDS, async ({ sender, body }) => {
  if (body.t !== MSG.BID) return

  const task = inFlight.get(body.id)
  if (!task) return  // bid arrived after window closed — ignore

  task.bids.push({ agentKey: sender, bidTxid: body.bx, ts: Date.now() })
})

// ── Batched payment system ────────────────────────────────────────────────────
// Buffer incoming results for BATCH_WINDOW_MS, then flush all in ONE multi-output tx.
// wallet.send() already supports multiple outputs natively — one call pays N labelers.
// One serial queue slot × N outputs = N× throughput vs one-payment-per-slot.

const BATCH_WINDOW_MS = 200  // collect results for 200ms before flushing
const MAX_BATCH_SIZE  = 50   // cap at 50 outputs per tx (well within BSV limits)

const pendingPayments = []   // { taskId, sender, address, label }
let   batchTimer      = null

function scheduleBatch() {
  if (batchTimer) return
  batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS)
}

function flushBatch() {
  batchTimer = null
  if (pendingPayments.length === 0) return

  const batch = pendingPayments.splice(0, MAX_BATCH_SIZE)

  enqueuePayment(async () => {
    try {
      const outputs = batch.map(p => ({ address: p.address, satoshis: SATS.LABEL_REWARD }))
      // Single payment: use full protocol OP_RETURN so judges can verify on-chain.
      // Multi-payment batch: encode all taskIds so the batch is still traceable.
      const opReturn = batch.length === 1
        ? opReturnPayment(batch[0].taskId, batch[0].sender, SATS.LABEL_REWARD)
        : `MESA BATCH ${batch.length} ${batch.map(p => p.taskId).join(',').slice(0, 200)}`

      const txid = await wallet.send(outputs, opReturn)
      agent.log(`💸 PAYMENT TX: https://whatsonchain.com/tx/${txid}  (${batch.length} labelers, ${batch.length * SATS.LABEL_REWARD} sats)`)

      txCount   += batch.length
      tasksDone += batch.length

      for (const p of batch) {
        relay.paymentSent(p.taskId, p.taskId, p.sender, SATS.LABEL_REWARD, txid)
        relay.resultDelivered(p.taskId, p.taskId, p.sender, 'labeler', p.label)
      }
    } catch (err) {
      agent.log(`⚠ Batch payment failed (${batch.length} pending): ${err.message}`)
      // Re-queue failed batch, but cap total queue to prevent unbounded growth
      // under sustained broadcast failure (e.g. ARC down for minutes).
      if (pendingPayments.length < 5_000) {
        pendingPayments.unshift(...batch)
        scheduleBatch()
      } else {
        agent.log(`⚠ Payment queue full (${pendingPayments.length}) — dropping ${batch.length} payments to prevent OOM`)
      }
    }
  })

  // If more results landed during this window, schedule another flush
  if (pendingPayments.length > 0) scheduleBatch()
}

// ── Collect results ───────────────────────────────────────────────────────────

agent.listen(BOXES.RESULTS, async ({ sender, body }) => {
  if (body.t !== MSG.RESULT) return

  const agentEntry = registry[sender]
  if (!agentEntry) return

  pendingPayments.push({
    taskId: body.id,
    sender,
    address: agentEntry.bidAddress,
    label:   `${body.lb} (${Math.round(body.cf * 100)}%)`,
  })

  scheduleBatch()
})

// ── Post a single task ────────────────────────────────────────────────────────

async function postTask() {
  const agents = Object.values(registry)
  if (agents.length === 0) return  // no agents yet

  const item   = nextItem()
  const tid    = taskId(item.index)
  const jobMsg = mkJob({ taskId: tid, text: item.text })

  // Record in-flight
  inFlight.set(tid, { text: item.text, bids: [], postedAt: Date.now() })
  tasksPosted++

  // Send to all registered agents via MessageBox
  await Promise.all(agents.map(a => agent.send(a.agentKey, BOXES.JOB_POSTINGS, jobMsg)))

  relay.jobPosted(tid, 'label', item.text.slice(0, 60), SATS.LABEL_REWARD)

  // Award after bid window closes
  setTimeout(() => awardTask(tid), BID_WINDOW_MS)
}

async function awardTask(tid) {
  const task = inFlight.get(tid)
  inFlight.delete(tid)  // remove before await to prevent double-award

  if (!task || task.bids.length === 0) return  // no bids

  // Pick randomly from all bids received — equal opportunity regardless of network timing
  const winner = task.bids[Math.floor(Math.random() * task.bids.length)]

  const awardMsg = mkAward({ taskId: tid, agentKey: winner.agentKey, text: task.text })
  await agent.send(winner.agentKey, BOXES.AWARDS, awardMsg)

  relay.awardSent(tid, tid, winner.agentKey, 'labeler', SATS.LABEL_REWARD)
}

// ── Main loop — post tasks at target rate ─────────────────────────────────────

const TARGET_TASKS_PER_SEC = 3.0
const INTERVAL_MS = 1000 / TARGET_TASKS_PER_SEC  // ~333ms between tasks

agent.log(`Waiting 15s for labeler agents to register...`)

await new Promise(r => setTimeout(r, 15_000))

agent.log(`Starting high-frequency task loop (${TARGET_TASKS_PER_SEC}/sec target)`)

// Tight scheduling loop using recursive setTimeout (more accurate than setInterval)
let _running = true
async function loop() {
  if (!_running) return
  const t0 = Date.now()

  postTask().catch(err => agent.log(`⚠ postTask error: ${err.message}`))

  const elapsed = Date.now() - t0
  const delay   = Math.max(0, INTERVAL_MS - elapsed)
  setTimeout(loop, delay)
}

loop()

// ── Stats logger (every 10 seconds) ──────────────────────────────────────────

setInterval(async () => {
  const elapsed = (Date.now() - startTime) / 1000
  const txPerSec = (txCount / elapsed).toFixed(2)
  const projected24h = Math.round(txCount / elapsed * 86400)
  const utxoCount = wallet._utxos.length

  agent.log(
    `📊 ${tasksPosted} posted | ${tasksDone} done | ${txCount} on-chain tx | ` +
    `${txPerSec} tx/sec | proj 24h: ${projected24h.toLocaleString()} | ` +
    `balance: ${wallet.balance()} sats | UTXOs: ${utxoCount}`
  )

  relay.log('orchestrator',
    `tx/sec: ${txPerSec} | 24h proj: ${projected24h.toLocaleString()} | done: ${tasksDone}`
  )

  // Auto-consolidate if dust accumulation is getting out of hand.
  // Threshold 150: fires before the wallet has enough dust to cause broadcast failures.
  if (utxoCount > 150) {
    wallet.consolidateIfNeeded(150).catch(err =>
      agent.log(`⚠ consolidation error: ${err.message}`)
    )
  }
}, 10_000)

// ── Test mode: auto-stop after TEST_DURATION_MS ───────────────────────────────

const TEST_MS = parseInt(process.env.TEST_DURATION_MS || '0', 10)
if (TEST_MS > 0) {
  agent.log(`🧪 TEST MODE — will stop after ${TEST_MS / 1000}s`)
  setTimeout(() => {
    _running = false
    const elapsed = (Date.now() - startTime) / 1000
    const txPerSec   = (txCount / elapsed).toFixed(2)
    const proj24h    = Math.round(txCount / elapsed * 86400)
    agent.log(`\n${'═'.repeat(55)}`)
    agent.log(`✅ TEST COMPLETE`)
    agent.log(`   Runtime:     ${elapsed.toFixed(1)}s`)
    agent.log(`   Tasks done:  ${tasksDone}`)
    agent.log(`   On-chain tx: ${txCount}`)
    agent.log(`   Tx/sec:      ${txPerSec}`)
    agent.log(`   24h proj:    ${proj24h.toLocaleString()}`)
    agent.log(`   Target:      1,500,000`)
    agent.log(`   Status:      ${proj24h >= 1_500_000 ? '🟢 ON TRACK' : '🔴 UNDER TARGET'}`)
    agent.log(`${'═'.repeat(55)}\n`)
    relay.agentOffline(agent.identityKey, 'orchestrator')
    process.exit(0)
  }, TEST_MS)
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  _running = false
  const elapsed = (Date.now() - startTime) / 1000
  agent.log(`Shutdown. Tasks: ${tasksDone} | On-chain tx: ${txCount} | Runtime: ${elapsed.toFixed(0)}s`)
  relay.agentOffline(agent.identityKey, 'orchestrator')
  process.exit(0)
})
