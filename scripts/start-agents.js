/**
 * scripts/start-agents.js — Railway cloud launcher
 *
 * Starts orchestrator + 10 labelers as child processes using env vars
 * injected by Railway. No .env files needed — all keys come from Railway's
 * environment variable dashboard.
 *
 * Required Railway env vars:
 *   ORCHESTRATOR_KEY    — orchestrator private key hex
 *   ANTHROPIC_API_KEY   — Claude API key (for orchestrator)
 *   LABELER1_KEY … LABELER10_KEY — labeler private key hexes
 *   RELAY_URL           — wss://your-relay.up.railway.app (set by Railway)
 *   ORCHESTRATOR_PUBKEY — 027c413c3e93a33dba9e6cf9deb4891fb8f49901089c4de1b44f2c56f7e50c538e
 *
 * Usage (Railway start command):
 *   node scripts/start-agents.js
 */
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ── Validate required env vars ────────────────────────────────────────────────

const required = [
  'ORCHESTRATOR_KEY',
  'ANTHROPIC_API_KEY',
  'RELAY_URL',
  'ORCHESTRATOR_PUBKEY',
  ...Array.from({ length: 10 }, (_, i) => `LABELER${i + 1}_KEY`),
]

const missing = required.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error('[start-agents] Missing required env vars:', missing.join(', '))
  process.exit(1)
}

console.log('[start-agents] All env vars present — launching 11 agents...')
console.log(`[start-agents] Relay: ${process.env.RELAY_URL}`)

// ── Shared env base ───────────────────────────────────────────────────────────

const BASE_ENV = {
  ...process.env,
  MESSAGEBOX_HOST: 'https://messagebox.babbage.systems',
  NETWORK: 'mainnet',
}

// ── Process registry ──────────────────────────────────────────────────────────

const procs = []

function launch(name, scriptPath, extraEnv) {
  const env = { ...BASE_ENV, ...extraEnv }
  const proc = spawn('node', [scriptPath], {
    env,
    cwd: ROOT,
    stdio: 'inherit',
  })

  proc.on('exit', (code, signal) => {
    console.error(`[start-agents] ${name} exited — code=${code} signal=${signal}`)
    // Restart after 3s on unexpected exit
    if (code !== 0 && signal !== 'SIGTERM') {
      console.log(`[start-agents] Restarting ${name} in 3s...`)
      setTimeout(() => launch(name, scriptPath, extraEnv), 3000)
    }
  })

  procs.push({ name, proc })
  console.log(`[start-agents] Started ${name} (pid ${proc.pid})`)
  return proc
}

// ── Launch orchestrator ───────────────────────────────────────────────────────

launch('ORCH', path.join(ROOT, 'agents/orchestrator.js'), {
  AGENT_ROLE:       'orchestrator',
  AGENT_KEY:        process.env.ORCHESTRATOR_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
})

// ── Launch labelers (staggered 200ms apart to avoid UTXO stampede) ────────────

for (let i = 1; i <= 10; i++) {
  const idx = i
  setTimeout(() => {
    launch(`L${idx}`, path.join(ROOT, 'agents/labeler.js'), {
      AGENT_ROLE:       'labeler',
      INSTANCE_ID:      String(idx),
      AGENT_KEY:        process.env[`LABELER${idx}_KEY`],
      ORCHESTRATOR_KEY: process.env.ORCHESTRATOR_PUBKEY,
    })
  }, idx * 200)
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[start-agents] ${signal} received — stopping all agents...`)
  for (const { name, proc } of procs) {
    console.log(`[start-agents] Stopping ${name}...`)
    proc.kill('SIGTERM')
  }
  setTimeout(() => process.exit(0), 2000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
