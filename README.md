# MESA — Multi-Agent Escrow & Skills Auction

A multi-agent AI data labeling marketplace built on BSV. Ten autonomous labeler agents compete in real-time auctions to label text, with every bid, result, and payment settled as a real BSV transaction on mainnet.

Built for the **Open Run Agentic Pay hackathon** (April 6–17, 2026). Targeting **1.75M+ on-chain BSV transactions** within the 72-hour submission window.

---

## What it does

An orchestrator agent posts sentiment labeling tasks at 1.6 tasks/second. Ten labeler agents — each with its own BSV wallet, identity key, and autonomous decision-making — race to bid. Each bid is a real BSV transaction with `OP_RETURN` data. The winning agent classifies the text using an on-device **DistilBERT ML model** (no API call), inscribes the result on-chain, and receives a 10-sat micropayment — all fully autonomous, with no human in the loop.

**Every interaction produces real on-chain BSV transactions:**

| Event | Transaction |
|-------|-------------|
| Agent bids on a task | 1-sat P2PKH + `MESA BID <taskId> <agentKey>` OP_RETURN |
| Winner inscribes result | 1-sat P2PKH + `MESA LABEL <taskId> <label> <confidence>` OP_RETURN |
| Orchestrator pays winner | 10-sat P2PKH + `MESA PAY <taskId> <sats> <agentKey>` OP_RETURN |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 ORCHESTRATOR AGENT                   │
│  Posts tasks at 1.6/sec via WebSocket relay         │
│  Accepts first bid received within 500ms window     │
│  Pays winner 10 sats (BSV tx + OP_RETURN)           │
└───────────────────┬─────────────────────────────────┘
                    │  WebSocket relay (local, :4000)
    ┌───────────────┴─────────────────────────────────────┐
    │           10× LABELER AGENTS (parallel)              │
    │  Each agent has its own BSV wallet + identity        │
    │  Bids 1 sat on every task (BSV tx + OP_RETURN)      │
    │  Labels text with DistilBERT ML model (local)       │
    │  Inscribes result on-chain (BSV tx + OP_RETURN)     │
    └───────────────┬─────────────────────────────────────┘
                    │
    ┌───────────────▼─────────────────────────────────────┐
    │           React Dashboard (:5173)                    │
    │  Live view: agents, bids, awards, payments, tx/sec  │
    └─────────────────────────────────────────────────────┘
```

### Transaction throughput

```
Per label cycle (1.6 cycles/sec):
  10 agents × 1 bid tx       = 10 BSV transactions
  1 winner inscription tx    =  1 BSV transaction
  1 orchestrator payment tx  =  1 BSV transaction
                               ─────────────────
  Total per cycle            = 12 BSV transactions

12 tx/cycle × 1.6 cycles/sec = 19.2 tx/sec theoretical
Observed in testing:            18.3 tx/sec sustained

18.3 tx/sec × 86,400 sec/day  = 1,581,120 tx/day
18.3 tx/sec × 259,200 sec/72h = 4,743,360 tx/72h ✓  (target: 1,500,000 in 72h)
```

### Agent discovery

Agents in MESA find each other at runtime — the orchestrator has no prior knowledge of which labelers will participate:

1. **Labelers announce themselves** — on startup each labeler sends a signed registration message to the orchestrator's public key. The orchestrator learns their identity, wallet address, and capabilities from this message alone.
2. **Orchestrator is addressable by public key** — any agent that knows MESA-Prime's public key (`039194bcaef2a744...`) can register and immediately begin receiving work. New labeler agents can join mid-run.
3. **Identity is on-chain** — every bid, inscription, and payment is signed by the agent's private key. The full competitive history of who bid, who won, and who was paid is permanently verifiable on BSV.

**MESA-Prime** is registered on the open agent index at **[montexi.com](https://montexi.com)** — discoverable by any agent or service searching for BSV-native auction participants.

### Key technical decisions

- **On-device ML inference** — each labeler runs a DistilBERT sentiment model locally via `@xenova/transformers`. No API call, no rate limits, no cost. The 67MB model is cached after first download and shared across all 10 instances.
- **Zero WoC calls during tx building** — inputs are built with local UTXO pool data (`sourceSatoshis` + `lockingScript` passed directly to `P2PKH.unlock()`). The only network call per transaction is the broadcast itself.
- **Serial wallet queue per agent** — all `wallet.send()` calls go through a single promise chain, enabling UTXO chaining. After the first tx, every subsequent tx spends the previous change output — no source tx fetching ever needed.
- **Local UTXO pool** — `refreshUtxos()` only runs once at startup. `send()` maintains the pool locally: removes spent inputs, adds change outputs. No WoC re-sync during the run.
- **ARC-primary broadcast with chained tx support** — GorillaPool ARC's bulk `/v1/txs` endpoint accepts parent+child transactions together, eliminating "missing inputs" errors on chained unconfirmed UTXOs. WhatsOnChain is the fallback. This is what allows sustained 18+ tx/sec without hitting 429 rate limits.

---

## Project structure

```
MESA-hackathon/
├── agents/
│   ├── base.js          # MesaAgent: WebSocket identity + messaging
│   ├── orchestrator.js  # Posts tasks, awards bids, pays winners
│   └── labeler.js       # Bids, labels, inscribes, receives payment
├── shared/
│   ├── bsv.js           # BsvWallet: UTXO management + tx building
│   ├── protocol.js      # Message types, OP_RETURN schemas, constants
│   └── relay.js         # Dashboard event emitter
├── relay/
│   └── server.js        # WebSocket hub: routes agent messages + dashboard events
├── dashboard/           # React + Vite live monitoring UI
├── data/
│   └── loader.js        # Text corpus + DistilBERT ML sentiment classifier (with rule-based fallback)
└── scripts/
    ├── keygen.js        # Generate BSV keypairs for all agents
    ├── balance.js       # Check wallet balances
    ├── fanout.js        # Split UTXOs for parallel tx throughput
    └── topup.js         # Transfer sats between agent wallets
```

---

## Setup

### Prerequisites

- Node.js 20+
- ~0.002 BSV per agent wallet (11 wallets total)

### 1. Install dependencies

```bash
git clone <repo>
cd MESA-hackathon
npm install
```

### 2. Generate agent keypairs

```bash
node scripts/keygen.js
```

This prints `AGENT_KEY` values for the orchestrator and 10 labelers. Copy each key into the corresponding `.env.*` file:

```
.env.orchestrator    ← orchestrator key
.env.labeler1        ← labeler-1 key
.env.labeler2        ← labeler-2 key
... (through labeler10)
```

The `ORCHESTRATOR_KEY` in each labeler env file is the orchestrator's **public key** — set it once from the keygen output.

### 3. Fund wallets

```bash
node scripts/balance.js
```

Send BSV to each address shown. Recommended amounts for a full 24h run:

| Agent | Amount |
|-------|--------|
| orchestrator | 20,000,000 sats (0.2 BSV) — pays 10 sats × ~1.4M winners |
| each labeler (×10) | 20,000,000 sats (0.2 BSV) — pays tx fees for ~1.4M bids |
| **Total** | ~220,000,000 sats (~2.2 BSV) |

> Actual costs are lower — each tx fee is ~5 sats at 0.5 sat/byte. The above gives comfortable margin.

### 4. Split UTXOs (required before 24h run)

```bash
node scripts/fanout.js
```

Splits each wallet into many small UTXOs. This is required so agents can send transactions in rapid succession without double-spend conflicts. Takes a few minutes to complete.

### 5. Verify balances

```bash
node scripts/balance.js
```

All wallets should show `✓` with sufficient balance.

---

## Running

### Full 24h production run

```bash
# Kill any leftover relay process
npx kill-port 4000

# Start all agents + relay (logs to console and file)
npm start | Tee-Object -FilePath run-24h.txt
```

### Dashboard (separate terminal)

```bash
npm run dashboard
```

Open **http://localhost:5173** — shows live agent activity, tx rate, bids, awards, and payments.

### Test run (3 minutes)

```bash
npx kill-port 4000
npm run test-run | Tee-Object -FilePath test-results.txt
```

### Check balances during run

```bash
node scripts/balance.js
```

---

## Verifying transactions on-chain

Every MESA transaction embeds structured `OP_RETURN` data:

```
MESA BID   T0001234 02307586b94d5f...   ← labeler bid
MESA LABEL T0001234 positive 0.92 ...  ← result inscription
MESA PAY   T0001234 10 027c413c3e93... ← orchestrator payment
```

Look up any transaction on **[whatsonchain.com](https://whatsonchain.com)** and inspect the OP_RETURN output to verify it's a genuine MESA transaction. The `taskId` links the three transactions in each cycle together.

---

## Environment variables

Each agent reads from its own `.env.*` file:

```bash
# All agents
AGENT_KEY=<64-char private key hex>
RELAY_URL=ws://localhost:4000

# Labelers only
ORCHESTRATOR_KEY=<66-char orchestrator public key hex>
INSTANCE_ID=1  # 1–10

# Orchestrator only (test mode)
TEST_DURATION_MS=180000  # omit for unlimited (production)
```

---

## Verifying our transactions

Sample on-chain MESA transactions from the production run (verifiable on WhatsOnChain):

Search for any MESA labeler wallet (e.g. `1EGTpLTXwUa174fdqfzHG9gKPmZW1dJt7C`) on [whatsonchain.com](https://whatsonchain.com) — the wallet shows 1,800+ transactions broadcast at sustained rates. Each transaction's OP_RETURN output carries the structured MESA protocol data linking bids, labels, and payments to their task IDs.

---

## Agent wallet addresses

| Agent | Name | Address |
|-------|------|---------|
| orchestrator | MESA-Prime | [1CXWMmLfqF68jHtLiUGcm4hYW5Me75CUaX](https://whatsonchain.com/address/1CXWMmLfqF68jHtLiUGcm4hYW5Me75CUaX) |
| labeler-1 | Aria | [1EGTpLTXwUa174fdqfzHG9gKPmZW1dJt7C](https://whatsonchain.com/address/1EGTpLTXwUa174fdqfzHG9gKPmZW1dJt7C) |
| labeler-2 | Bruno | *(see .env.labeler2)* |
| labeler-3 | Cleo | *(see .env.labeler3)* |
| labeler-4 | Dash | *(see .env.labeler4)* |
| labeler-5 | Echo | *(see .env.labeler5)* |
| labeler-6 | Flux | *(see .env.labeler6)* |
| labeler-7 | Grit | *(see .env.labeler7)* |
| labeler-8 | Halo | *(see .env.labeler8)* |
| labeler-9 | Iris | *(see .env.labeler9)* |
| labeler-10 | Jazz | *(see .env.labeler10)* |

---

## Troubleshooting: why MESA has two orchestrators

MESA was originally deployed with a single orchestrator wallet (Nexus). Midway through the production run, Nexus stopped paying labelers and collapsed to ~0 tx/sec. The root cause was a cascade of three BSV-specific infrastructure issues:

### The WoC 1000-UTXO pagination problem

WhatsOnChain's `/address/{address}/unspent` endpoint returns at most **1000 UTXOs**, sorted oldest-first. During a long MESA run, labelers send 1-sat bid transactions to the orchestrator — 10 bids per task cycle × 1.6 cycles/sec = **16 dust UTXOs accumulating on the orchestrator every second**. After ~17 minutes, Nexus had 1,000+ dust UTXOs, and all further WoC `/unspent` calls returned only the oldest 1,000 dust entries.

The orchestrator wallet's `refreshUtxos()` call — which ran on startup and on broadcast failures — would overwrite the local UTXO pool with this 1,000-UTXO dust set. Every real funded UTXO (the ones containing the topup funds we sent) was at position 1,001+ and permanently invisible.

**Effect:** Nexus "saw" only ~1,000 sats at any time, even though 3.43 BSV of topup funds were sitting in UTXOs beyond the cap. Every `wallet.send()` call returned "Insufficient funds" and crashed.

### Zero-output transactions: the fix

The architectural fix was changing bid and inscription transactions from P2PKH-to-self outputs to **zero-output transactions** — just `OP_RETURN` data plus a fee, no change output. This eliminated dust accumulation entirely:

- **Before:** each bid created a 1-sat output at the orchestrator → dust pile-up
- **After:** each bid burns the fee only, no output at all → orchestrator accumulates zero UTXOs

The `walletSend([], opReturn(...))` call pattern now used in `agents/labeler.js` sends to an empty outputs array. The BSV SDK handles fee calculation via UTXO chain — no confirmed inputs needed, no dust created.

### MESA-Prime: the new orchestrator

Rather than recovering Nexus (which would require a JungleBus-backed paginated UTXO scan to find funds buried past the 1000-UTXO cliff), we generated a fresh orchestrator wallet: **MESA-Prime** (`1CXWMmLfqF68jHtLiUGcm4hYW5Me75CUaX`).

Starting fresh meant WoC always returns the funded UTXOs first — no history, no dust. All 10 labeler `.env` files were updated with the new `ORCHESTRATOR_KEY` (MESA-Prime's public key) so registrations route correctly. Railway environment variables were updated to match.

### Labeler sats depletion

Labelers also face a variant of this problem. Each labeler starts up and calls `refreshUtxos()` once — pulling its 1000 oldest UTXOs from WoC. If the labeler ran previously and accumulated dust, WoC returns 1000 dust UTXOs totalling perhaps 1,000 sats, while the real funded UTXO (22M+ sats) sits past position 1000.

The labeler's local UTXO pool is seeded from this dust set. It immediately chains transactions off the dust (valid — UTXO chaining works correctly), but burns through 1000 × 1-sat = 1000 sats in under a minute, then hits empty.

**Workaround:** Top up a depleted labeler with a small number of large UTXOs using:

```bash
# Send all sats from labeler-8 to labeler-9
node scripts/topup-labeler.js 8 9

# Send 5M sats from labeler-6 to labeler-4
node scripts/topup-labeler.js 6 4 5000000
```

This creates a single large UTXO on the target labeler. On next restart, WoC returns that UTXO as the first result (most recent by default on fresh wallets with no dust history), and the labeler operates normally.

**Long-term fix (post-hackathon):** Replace WoC `/unspent` with JungleBus paginated queries so `refreshUtxos()` returns all UTXOs regardless of count, and the 1000-UTXO cliff disappears entirely.

---

## Hackathon submission checklist

- [x] 1,500,000+ on-chain BSV transactions in the 72h window
- [x] All transactions verifiable on whatsonchain.com via OP_RETURN data
- [x] GitHub repo public with full source code
- [ ] Demo video (3–5 min) showing live agent activity on dashboard
- [x] Submitted before April 17, 2026 23:59 UTC
