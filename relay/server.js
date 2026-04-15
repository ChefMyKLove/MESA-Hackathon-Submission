/**
 * relay/server.js — MESA Dashboard Relay Server
 *
 * A lightweight WebSocket hub that:
 *  - Receives events from all agents (they connect as clients)
 *  - Broadcasts those events to the React dashboard
 *
 * Port 4000 (agents connect here to push events)
 * Port 4001 (dashboard connects here to subscribe)
 *
 * Uses a single port with a "role" handshake to distinguish publishers vs subscribers.
 */
import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import express from 'express'

const PORT = parseInt(process.env.PORT || process.env.RELAY_PORT || '4000')

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load agent card — check both repo root (local) and relay dir (Railway workspace deploy)
let agentCard = null
for (const base of [join(__dirname, '..'), __dirname]) {
  try {
    agentCard = JSON.parse(readFileSync(join(base, '.well-known', 'agent-card.json'), 'utf8'))
    break
  } catch { /* try next path */ }
}

const app = express()

// CORS for dashboard + Montexi crawler
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  next()
})

// ── Agent discovery endpoints ─────────────────────────────────────────────────

// Root landing — Montexi and humans both land here
app.get('/', (req, res) => res.json({
  name: 'MESA — Multi-Agent Escrow & Skills Auction',
  description: 'Autonomous BSV labeling marketplace. 10 agents compete in real-time auctions. Every bid, result, and payment is an on-chain BSV transaction.',
  agent: 'Nexus (orchestrator)',
  bsv_public_key: agentCard?.identity?.bsv_public_key,
  bsv_address:    agentCard?.identity?.bsv_address,
  agent_card:     '/.well-known/agent-card.json',
  health:         '/health',
  built_for:      'Open Run Agentic Pay Hackathon 2026',
}))

// A2A agent card — Montexi crawls this
app.get('/.well-known/agent-card.json', (req, res) => {
  if (!agentCard) return res.status(404).json({ error: 'agent card not found' })
  res.json(agentCard)
})

// llms.txt — machine-readable description (boosts Montexi readiness score)
app.get('/llms.txt', (req, res) => {
  res.type('text/plain').send(`# MESA — Multi-Agent Escrow & Skills Auction

> Autonomous BSV data labeling marketplace. 10 AI agents bid, work, and earn BSV micropayments on-chain.

## Nexus (Orchestrator Agent)
- BSV public key: ${agentCard?.identity?.bsv_public_key ?? 'see agent-card.json'}
- Posts sentiment labeling tasks at 1.6/sec
- Awards contract to fastest bidder (1-sat BSV bid tx)
- Pays 10 sats per completed label (BSV P2PKH tx)

## Protocol
- Agents self-register by sending a signed REGISTER message to Nexus's public key
- No prior coordination needed — any agent knowing the public key can join
- All interactions produce OP_RETURN inscriptions on BSV mainnet

## On-chain verification
- Every transaction verifiable at whatsonchain.com
- OP_RETURN format: MESA BID|LABEL|PAY <taskId> <agentKey>

## Source
- https://github.com/ChefMyKLove/MESA-Hackathon-Submission
`)
})

// ── Existing relay endpoints ──────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }))

// Serve recent event history for dashboard initial load
const eventHistory = []
const MAX_HISTORY = 200

app.get('/events', (req, res) => res.json(eventHistory))

const server = createServer(app)
const wss = new WebSocketServer({ server })

const subscribers  = new Set()   // dashboard connections
const publishers   = new Set()   // agent dashboard-event connections
const agentRoutes  = new Map()   // agentKey → ws (for agent-to-agent routing)

wss.on('connection', (ws) => {
  let role     = null
  let agentKey = null

  ws.on('message', (raw) => {
    let data
    try { data = JSON.parse(raw) } catch { return }

    // First message identifies the connection role
    if (!role) {
      if (data.role === 'subscriber') {
        role = 'subscriber'
        subscribers.add(ws)
        ws.send(JSON.stringify({ type: 'history', events: eventHistory }))
        console.log(`[RELAY] Dashboard connected (${subscribers.size} subscribers)`)

      } else if (data.role === 'publisher') {
        role = 'publisher'
        publishers.add(ws)
        console.log(`[RELAY] Event publisher connected (${publishers.size} publishers)`)

      } else if (data.role === 'agent') {
        role     = 'agent'
        agentKey = data.agentKey
        agentRoutes.set(agentKey, ws)
        console.log(`[RELAY] Agent registered: ${agentKey?.slice(0, 16)}... (${agentRoutes.size} agents)`)
      }
      return
    }

    // Publishers broadcast dashboard events to all subscribers
    if (role === 'publisher') {
      eventHistory.push(data)
      if (eventHistory.length > MAX_HISTORY) eventHistory.shift()

      const payload = JSON.stringify(data)
      for (const sub of subscribers) {
        if (sub.readyState === WebSocket.OPEN) sub.send(payload)
      }
    }

    // Agents route messages to specific recipients
    if (role === 'agent' && data.type === 'agent_msg') {
      const target = agentRoutes.get(data.to)
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify(data))
      }
      // If target not connected yet, silently drop (sender will retry via protocol)
    }
  })

  ws.on('close', () => {
    subscribers.delete(ws)
    publishers.delete(ws)
    if (agentKey) agentRoutes.delete(agentKey)
  })

  ws.on('error', () => {
    subscribers.delete(ws)
    publishers.delete(ws)
    if (agentKey) agentRoutes.delete(agentKey)
  })
})

// Bind to 0.0.0.0 — required for Railway/cloud hosting (localhost only is unreachable)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[RELAY] Server running on 0.0.0.0:${PORT}`)
  console.log(`[RELAY] Health: http://0.0.0.0:${PORT}/health`)
  console.log(`[RELAY] History: http://0.0.0.0:${PORT}/events`)
})
