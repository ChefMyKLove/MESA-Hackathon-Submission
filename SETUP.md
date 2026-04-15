# MESA Setup Guide
### Multi-Agent Escrow & Skills Auction — AI Data Labeling Marketplace on BSV

---

## Architecture

```
┌─────────────────────────────────────────────┐
│            ORCHESTRATOR AGENT               │
│  Feeds text items at 1.6 tasks/sec         │
│  Posts jobs via MessageBox (P2P)           │
│  Awards lowest-latency bid                  │
│  Pays 10 sats per label (BSV tx)           │
└──────────┬──────────────────────────────────┘
           │  MessageBox (P2P, off-chain)
    ┌──────┴──────────────────────────────────────┐
    │  10× LABELER AGENTS (parallel instances)    │
    │  Each: bids 1 sat (BSV tx + OP_RETURN)     │
    │  Labels text via DistilBERT ML (local)     │
    │  Inscribes result (BSV tx + OP_RETURN)     │
    └──────┬──────────────────────────────────────┘
           │
    ┌──────▼──────────────────────────────────────┐
    │  WebSocket Relay :4000                      │
    └──────┬──────────────────────────────────────┘
           │
    ┌──────▼──────────────────────────────────────┐
    │  React Dashboard :5173                      │
    │  Agents · Messages · Payments · Tx rate    │
    └─────────────────────────────────────────────┘
```

### Transaction math
```
Per label cycle:
  10 agents × 1 bid tx each   = 10 BSV transactions
  1 result inscription tx      =  1 BSV transaction
  1 payment tx (orchestrator)  =  1 BSV transaction
  ─────────────────────────────────────────────────
  Total per label              = 12 BSV transactions

Rate: 1.58 labels/sec × 12 tx/label = 18.96 tx/sec
Per day: 18.96 × 86,400            = 1,638,144 tx ✓
```

---

## Step 1 — Install

```bash
cd C:\Users\micha\Desktop\MESA-hackathon
npm run setup
```

---

## Step 2 — Generate Keys (all 11 agents)

```bash
node scripts/keygen.js
```

This prints keys for: `orchestrator`, `labeler1` … `labeler10`.

Paste the `AGENT_KEY` line into each `.env.*` file.
The `ORCHESTRATOR_KEY` in all labeler env files is already set to the
orchestrator's public key from the original keygen run.

---

## Step 3 — Fund Agent Wallets

Run to see all addresses and balances:
```bash
node scripts/balance.js
```

Send BSV to each address:

| Agent | Address | Amount needed |
|-------|---------|---------------|
| orchestrator | (from balance.js) | 200,000 sats (0.002 BSV) |
| labeler1–10 | (from balance.js) | 30,000 sats each (0.0003 BSV) |
| **TOTAL** | | **~500,000 sats ≈ $0.20** |

> ⚠ The orchestrator pays winners — it needs the most funds.
> Labelers only need enough for bid deposits (1 sat) + tx fees (~95 sats each).

---

## Step 4 — Pre-split UTXOs (CRITICAL before 24h run)

Each agent needs many small UTXOs ready. Run this once after funding:

```bash
node scripts/fanout.js
```

This splits each wallet into 150 × 200-sat UTXOs so agents can bid
simultaneously without double-spend collisions.

---

## Step 5 — Run

### Terminal 1 — All agents + relay
```bash
npm start
```

### Terminal 2 — Dashboard
```bash
npm run dashboard
```

Open **http://localhost:5173**

---

## Step 6 — Monitor the 24h run

Watch the stats log from the orchestrator:
```
📊 1580 posted | 1420 done | 17040 on-chain tx | 17.32 tx/sec | proj 24h: 1,496,448
```

Check balances during run:
```bash
node scripts/balance.js
```

---

## Cost Summary

| Item | Amount | Cost |
|------|--------|------|
| BSV tx fees (1.5M tx × ~100 sats avg) | ~150,000,000 sats | ~$60 |
| Initial wallet funding | ~500,000 sats | ~$0.20 |
| ML model (@xenova/transformers DistilBERT) | one-time download, runs locally | free |
| **Total** | | **~$60** |

---

## Verifying transactions on-chain

All MESA transactions embed `OP_RETURN` data in the format:
```
MESA BID   <taskId> <agentKeyPrefix>
MESA LABEL <taskId> <label> <confidence> <agentKeyPrefix>
MESA PAY   <taskId> <sats> <agentKeyPrefix>
```

Search any transaction on **whatsonchain.com** and look at the OP_RETURN output
to verify it's a genuine MESA labeling transaction.

---

## Troubleshooting

**"ProtoWallet unavailable"**
→ `npm install` in the project root. If still fails, check `npm ls @bsv/wallet-toolbox`.

**"AGENT_KEY not set"**
→ Open the `.env.*` file for that agent and paste the `AGENT_KEY=` line from keygen output.

**"Insufficient funds"**
→ Run `node scripts/balance.js` and fund the flagged addresses.

**Agents not seeing each other**
→ Make sure the relay is running first (`npm run relay`). All agents connect to it at startup.
→ Orchestrator waits 15s for labelers to register — this is normal.

**Low tx rate (< 10 tx/sec)**
→ Run fanout first: `node scripts/fanout.js` — splits UTXOs so agents can chain transactions.
→ Check orchestrator balance: `node scripts/balance.js`. Low balance = slow/stopped payments.

**ML model download on first run**
→ First startup downloads DistilBERT (~67MB) from HuggingFace — takes 30–60s on fast connections.
→ Subsequent starts use the local cache (`.cache/huggingface`). Add to `.gitignore` if pushing to GitHub.

---

## Submission checklist

- [x] 1.5M+ on-chain tx in the 72h window (verifiable on WoC)
- [x] GitHub repo public with this source code
- [x] README with architecture diagram + setup instructions
- [ ] 3–5 min demo video showing agents transacting live
- [x] Submitted before April 17, 2026 at 23:59 UTC
