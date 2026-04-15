/**
 * relay.js — Agents use this to push events to the dashboard relay server.
 * Fire-and-forget: events are best-effort; agent logic never blocks on this.
 */
import { WebSocket } from 'ws'

const RELAY_URL = process.env.RELAY_URL || 'ws://localhost:4000'

let _ws = null
let _queue = []
let _connected = false

function connect() {
  try {
    _ws = new WebSocket(RELAY_URL)

    _ws.on('open', () => {
      _connected = true
      // Identify as publisher
      _ws.send(JSON.stringify({ role: 'publisher' }))
      // Flush queued events
      for (const evt of _queue) _ws.send(JSON.stringify(evt))
      _queue = []
    })

    _ws.on('close', () => {
      _connected = false
      _ws = null
      // Reconnect after 3s
      setTimeout(connect, 3000)
    })

    // Node.js v24 throws AggregateError (bundled IPv4+IPv6 ECONNREFUSED) that
    // can bypass older error listeners — nullify _ws silently here too.
    _ws.on('error', () => {
      _connected = false
      _ws = null
    })
  } catch {
    _ws = null
    setTimeout(connect, 3_000)
  }
}

// Delay first attempt 1s — gives the relay process time to bind before agents connect.
// Subsequent reconnects (via the close handler) fire immediately since relay is running.
setTimeout(connect, 1_000)

export function emit(type, data) {
  const evt = { type, data, ts: Date.now() }
  if (_connected && _ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(evt))
  } else {
    // Cap queue at 100 events to avoid memory leak
    if (_queue.length < 100) _queue.push(evt)
  }
}

// Event type helpers
export const relay = {
  agentOnline: (agentKey, role) =>
    emit('agent:online', { agentKey, role }),

  agentOffline: (agentKey, role) =>
    emit('agent:offline', { agentKey, role }),

  message: (from, to, box, body) =>
    emit('message', { from, to, box, body }),

  jobPosted: (jobId, taskType, prompt, budget) =>
    emit('job:posted', { jobId, taskType, prompt, budget }),

  bidReceived: (jobId, taskId, agentKey, role, bidSats) =>
    emit('bid:received', { jobId, taskId, agentKey, role, bidSats }),

  awardSent: (jobId, taskId, agentKey, role, agreedSats) =>
    emit('award:sent', { jobId, taskId, agentKey, role, agreedSats }),

  workStarted: (jobId, taskId, agentKey, role) =>
    emit('work:started', { jobId, taskId, agentKey, role }),

  resultDelivered: (jobId, taskId, agentKey, role, output) =>
    emit('result:delivered', { jobId, taskId, agentKey, role, output }),

  paymentSent: (jobId, taskId, agentKey, satsPaid, txid) =>
    emit('payment:sent', { jobId, taskId, agentKey, satsPaid, txid }),

  log: (role, msg) =>
    emit('log', { role, msg }),
}
