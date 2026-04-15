/**
 * agents/base.js — Foundation for all MESA agents.
 *
 * Uses LocalMessenger (relay-based WebSocket routing) instead of
 * @bsv/message-box-client. Agent-to-agent messages route through our
 * own relay server — zero external dependencies, sub-millisecond delivery.
 *
 * BSV wallet transactions are unchanged — every bid, result, and payment
 * is still a real on-chain BSV transaction.
 */
import { PrivateKey } from '@bsv/sdk'
import { LocalMessenger } from '../shared/messenger.js'
import { relay } from '../shared/relay.js'
import { parseBody } from '../shared/protocol.js'

export class MesaAgent {
  constructor(role) {
    this.role        = role
    this.identityKey = null    // set in init()
    this.messenger   = null    // LocalMessenger
  }

  async init() {
    const keyHex = process.env.AGENT_KEY
    if (!keyHex) throw new Error(`AGENT_KEY not set for ${this.role}`)

    // Identity key = compressed public key hex (same as before)
    const privKey = PrivateKey.fromHex(keyHex)
    this.identityKey = privKey.toPublicKey().toString()

    // Connect to relay for agent-to-agent routing
    const relayUrl = process.env.RELAY_URL || 'ws://localhost:4000'
    this.messenger  = new LocalMessenger(keyHex)
    await this.messenger.init(relayUrl)

    this.log(`online | key: ${this.identityKey.slice(0, 16)}...`)
    relay.agentOnline(this.identityKey, this.role)

    return this
  }

  // Send a message to another agent via relay routing
  async send(recipientKey, box, body) {
    try {
      this.messenger.send(recipientKey, box, typeof body === 'string' ? parseBody(body) : body)
      relay.message(this.identityKey, recipientKey, box, body)
    } catch (err) {
      this.log(`⚠ send failed → ${box}: ${err.message}`)
    }
  }

  // Register a handler for incoming messages on a box
  async listen(box, handler) {
    this.messenger.listen(box, async (msg) => {
      const body = typeof msg.body === 'string' ? parseBody(msg.body) : msg.body
      try {
        await handler({ sender: msg.from, body, messageId: msg.id })
      } catch (err) {
        this.log(`⚠ handler error [${box}]: ${err.message}`)
      }
    })
    this.log(`listening on ${box}`)
  }

  log(msg) {
    const time = new Date().toISOString().slice(11, 19)
    console.log(`[${time}] [${this.role.toUpperCase()}] ${msg}`)
    relay.log(this.role, msg)
  }
}
