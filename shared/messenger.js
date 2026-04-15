/**
 * shared/messenger.js — Local agent-to-agent messaging via the MESA relay.
 *
 * Replaces @bsv/message-box-client with a direct WebSocket connection to
 * our own relay server. Zero external dependencies, sub-millisecond delivery,
 * fully controlled routing.
 *
 * Message format (agent → relay → agent):
 *   { type: 'agent_msg', to: recipientKey, from: senderKey, box: 'BOX_NAME', body: {...} }
 */
import { WebSocket } from 'ws'
import { PrivateKey } from '@bsv/sdk'

export class LocalMessenger {
  constructor(agentKeyHex) {
    const priv = PrivateKey.fromHex(agentKeyHex)
    this.agentKey  = priv.toPublicKey().toString()
    this._handlers = {}   // box → handler fn
    this._ws       = null
    this._ready    = false
    this._queue    = []   // messages queued before connect
    this._relayUrl = 'ws://localhost:4000'
  }

  async init(relayUrl = 'ws://localhost:4000') {
    this._relayUrl = relayUrl
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)
      this._ws = ws

      ws.on('open', () => {
        // Register as an agent (routing identity)
        ws.send(JSON.stringify({ role: 'agent', agentKey: this.agentKey }))
        this._ready = true
        // Flush any messages queued before connect
        for (const m of this._queue) ws.send(m)
        this._queue = []
        resolve()
      })

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw)
          if (msg.type !== 'agent_msg') return
          if (msg.to !== this.agentKey) return
          const handler = this._handlers[msg.box]
          if (handler) handler(msg)
        } catch { /* ignore malformed */ }
      })

      ws.on('error', (err) => {
        if (!this._ready) reject(err)
      })

      ws.on('close', () => {
        this._ready = false
        // Auto-reconnect after 1s
        setTimeout(() => {
          this.init(this._relayUrl).catch(() => {})
        }, 1000)
      })
    })
  }

  send(recipientKey, box, body) {
    const payload = JSON.stringify({
      type: 'agent_msg',
      to:   recipientKey,
      from: this.agentKey,
      box,
      body,
    })
    if (this._ready) {
      this._ws.send(payload)
    } else {
      this._queue.push(payload)
    }
  }

  listen(box, handler) {
    this._handlers[box] = handler
  }
}
