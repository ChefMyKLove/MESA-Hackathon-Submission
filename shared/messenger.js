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
    this.agentKey       = priv.toPublicKey().toString()
    this._handlers      = {}     // box → handler fn
    this._ws            = null
    this._ready         = false
    this._queue         = []     // messages queued before connect
    this._relayUrl      = 'ws://localhost:4000'
    this._reconnecting  = false  // guard against duplicate concurrent reconnects
    this._reconnAttempt = 0      // exponential backoff counter
    this._generation    = 0      // incremented on each init() — stale WS events ignored
  }

  async init(relayUrl = 'ws://localhost:4000') {
    this._relayUrl = relayUrl
    const gen = ++this._generation

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(relayUrl)
      this._ws = ws
      let settled = false

      ws.on('open', () => {
        if (gen !== this._generation) { ws.close(); return }
        ws.send(JSON.stringify({ role: 'agent', agentKey: this.agentKey }))
        this._ready         = true
        this._reconnecting  = false
        this._reconnAttempt = 0
        for (const m of this._queue) ws.send(m)
        this._queue = []
        if (!settled) { settled = true; resolve() }
      })

      ws.on('message', (raw) => {
        if (gen !== this._generation) return
        try {
          const msg = JSON.parse(raw)
          if (msg.type !== 'agent_msg') return
          if (msg.to !== this.agentKey) return
          const handler = this._handlers[msg.box]
          if (handler) handler(msg)
        } catch { /* ignore malformed */ }
      })

      ws.on('error', (err) => {
        if (!settled) { settled = true; reject(err) }
        // 'close' fires after 'error' — reconnect logic lives there
      })

      ws.on('close', () => {
        if (gen !== this._generation) return  // stale WebSocket — ignore
        this._ready = false
        this._scheduleReconnect()
      })
    })
  }

  // Exponential backoff reconnect: 1s, 2s, 4s, 8s, 16s, 30s cap.
  // Retries indefinitely until the relay comes back.
  _scheduleReconnect() {
    if (this._reconnecting) return
    this._reconnecting = true
    this._reconnAttempt++
    const delay = Math.min(1000 * Math.pow(2, this._reconnAttempt - 1), 30_000)
    setTimeout(async () => {
      try {
        await this.init(this._relayUrl)
        // success: open handler clears _reconnecting + _reconnAttempt
      } catch {
        // relay still down — allow _scheduleReconnect to fire again
        this._reconnecting = false
        this._scheduleReconnect()
      }
    }, delay)
  }

  send(recipientKey, box, body) {
    const payload = JSON.stringify({
      type: 'agent_msg',
      to:   recipientKey,
      from: this.agentKey,
      box,
      body,
    })
    if (this._ready && this._ws) {
      this._ws.send(payload)
    } else {
      this._queue.push(payload)
    }
  }

  listen(box, handler) {
    this._handlers[box] = handler
  }
}
