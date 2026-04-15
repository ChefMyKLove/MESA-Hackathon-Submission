/**
 * keygen.js — Generate private keys for all MESA agents
 * Run: node scripts/keygen.js
 */
import { PrivateKey } from '@bsv/sdk'

const AGENTS = [
  'orchestrator',
  'labeler1', 'labeler2', 'labeler3', 'labeler4', 'labeler5',
  'labeler6', 'labeler7', 'labeler8', 'labeler9', 'labeler10',
]

console.log('\n🔑 MESA Agent Key Generation\n')
console.log('Copy each block into the corresponding .env file:\n')
console.log('─'.repeat(60))

for (const agent of AGENTS) {
  const privKey = PrivateKey.fromRandom()
  const pubKey  = privKey.toPublicKey()
  console.log(`\n# .env.${agent}`)
  console.log(`AGENT_KEY=${privKey.toHex()}`)
  console.log(`AGENT_PUBKEY=${pubKey.toString()}`)
}

console.log('\n' + '─'.repeat(60))
console.log('\n⚠️  Each agent needs its own funded BSV address.')
console.log('Run `node scripts/balance.js` after funding to verify.\n')
console.log('Funding amounts needed:')
console.log('  orchestrator : 200,000 sats (0.002 BSV ≈ $0.08)')
console.log('  each labeler :  30,000 sats (0.0003 BSV ≈ $0.012)')
console.log('  TOTAL        : 500,000 sats (0.005 BSV ≈ $0.20)\n')
