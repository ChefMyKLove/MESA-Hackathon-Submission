/**
 * MESA Message Protocol — Labeling Marketplace Edition
 *
 * Transaction flow per label (3 on-chain BSV txs per item):
 *   1. Agent bids: sends 1 sat to orchestrator (BSV tx + OP_RETURN bid data)
 *   2. Orchestrator awards + pays winner: sends (LABEL_REWARD) sats (BSV tx)
 *   3. Winner inscribes result: OP_RETURN with labeled data (BSV tx)
 *
 * 10 agents × 1.58 bids/sec + 1.58 payments/sec = 17.4 on-chain tx/sec
 * × 86,400 sec/day = 1,503,360 tx/day ✓
 */

// MessageBox names (P2P coordination — off-chain)
export const BOXES = {
  REGISTRATIONS: 'mesa_reg_v2',
  JOB_POSTINGS:  'mesa_job_v2',
  BIDS:          'mesa_bid_v2',
  AWARDS:        'mesa_award_v2',
  RESULTS:       'mesa_result_v2',
}

// BSV economic constants (in satoshis)
export const SATS = {
  BID_DEPOSIT:    1,    // each agent pays 1 sat to bid (proves economic intent)
  LABEL_REWARD:   10,   // orchestrator pays 10 sats to winning labeler
  MIN_UTXO:       200,  // minimum UTXO to keep in wallet
}

// Bid window: how long orchestrator waits before picking winner
export const BID_WINDOW_MS = 250  // 250ms — relay loopback is <50ms, 250ms is plenty

// Sentiment labels (the actual task output)
export const LABELS = {
  POSITIVE: 'positive',
  NEGATIVE: 'negative',
  NEUTRAL:  'neutral',
}

// Message type tags (embedded in OP_RETURN and MessageBox bodies)
export const MSG = {
  REGISTER: 'REG',
  JOB:      'JOB',
  BID:      'BID',
  AWARD:    'AWD',
  RESULT:   'RES',
}

// ── On-chain OP_RETURN data schemas ─────────────────────────────────────────
// All OP_RETURN fields are space-separated ASCII, prefixed with "MESA"
// This makes them searchable/verifiable on-chain via JungleBus or WoC

export function opReturnBid(taskId, agentKey) {
  return `MESA BID ${taskId} ${agentKey.slice(0, 16)}`
}

export function opReturnResult(taskId, agentKey, label, confidence) {
  return `MESA LABEL ${taskId} ${label} ${confidence} ${agentKey.slice(0, 16)}`
}

export function opReturnPayment(taskId, agentKey, sats) {
  return `MESA PAY ${taskId} ${sats} ${agentKey.slice(0, 16)}`
}

// ── MessageBox message factories ─────────────────────────────────────────────

export function mkRegister({ agentKey, bidAddress }) {
  return { t: MSG.REGISTER, k: agentKey, a: bidAddress }
}

export function mkJob({ taskId, text }) {
  return { t: MSG.JOB, id: taskId, tx: text }
}

export function mkBid({ taskId, agentKey, bidTxid }) {
  return { t: MSG.BID, id: taskId, k: agentKey, bx: bidTxid }
}

export function mkAward({ taskId, agentKey, text }) {
  return { t: MSG.AWARD, id: taskId, k: agentKey, tx: text }
}

export function mkResult({ taskId, agentKey, label, confidence, resultTxid }) {
  return { t: MSG.RESULT, id: taskId, k: agentKey, lb: label, cf: confidence, rx: resultTxid }
}

export function parseBody(body) {
  if (typeof body === 'string') {
    try { return JSON.parse(body) } catch { return { raw: body } }
  }
  return body ?? {}
}

export function taskId(index) {
  return `T${index.toString().padStart(7, '0')}`
}
