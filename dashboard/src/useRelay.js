/**
 * useRelay — subscribes to the relay WebSocket and returns live state.
 */
import { useEffect, useReducer, useRef, useState } from 'react'

const RELAY_URL    = import.meta.env.VITE_RELAY_URL || 'ws://localhost:4000'
const MAX_MESSAGES = 80
const MAX_PAYMENTS = 50
const MAX_LOGS     = 120
const MAX_RESULTS  = 20
const MAX_CYCLES   = 500   // detail view keeps last 500 completed label cycles

function reducer(state, action) {
  switch (action.type) {

    case 'history':
      return action.events.reduce(reducer, state)

    case 'agent:online':
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.data.agentKey]: {
            ...(state.agents[action.data.agentKey] || {}),
            agentKey: action.data.agentKey,
            role:     action.data.role,
            label:    action.data.label || action.data.role,
            status:   'idle',
            online:   true,
            completedTasks: (state.agents[action.data.agentKey] || {}).completedTasks || 0,
            bidsWon:        (state.agents[action.data.agentKey] || {}).bidsWon        || 0,
            totalEarned:    (state.agents[action.data.agentKey] || {}).totalEarned    || 0,
          },
        },
      }

    case 'agent:offline':
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.data.agentKey]: {
            ...(state.agents[action.data.agentKey] || {}),
            online: false,
            status: 'offline',
          },
        },
      }

    case 'bid:received':
      return {
        ...state,
        totalTxs: state.totalTxs + 1,
        agents: {
          ...state.agents,
          [action.data.agentKey]: {
            ...(state.agents[action.data.agentKey] || {}),
            status: 'bidding',
          },
        },
        messages: [
          { _isBid: true, ...action.data, ts: action.ts },
          ...state.messages,
        ].slice(0, MAX_MESSAGES),
        // Accumulate bids per task so the cycle knows who competed
        pendingCycles: {
          ...state.pendingCycles,
          [action.data.taskId]: {
            ...(state.pendingCycles[action.data.taskId] || {}),
            taskId:   action.data.taskId,
            bidders:  [...((state.pendingCycles[action.data.taskId] || {}).bidders || []), action.data.agentKey],
          },
        },
      }

    case 'job:posted':
      return {
        ...state,
        messages: [
          { _isJob: true, ...action.data, ts: action.ts },
          ...state.messages,
        ].slice(0, MAX_MESSAGES),
        // Start tracking this cycle
        pendingCycles: {
          ...state.pendingCycles,
          [action.data.jobId]: {
            ...(state.pendingCycles[action.data.jobId] || {}),
            taskId:  action.data.jobId,
            text:    action.data.prompt || '',
            postedAt: action.ts,
            bidders: [],
          },
        },
      }

    case 'award:sent':
      return {
        ...state,
        agents: {
          ...state.agents,
          [action.data.agentKey]: {
            ...(state.agents[action.data.agentKey] || {}),
            status: 'working',
            bidsWon: ((state.agents[action.data.agentKey] || {}).bidsWon || 0) + 1,
          },
        },
        messages: [
          { _isAward: true, ...action.data, ts: action.ts },
          ...state.messages,
        ].slice(0, MAX_MESSAGES),
        pendingCycles: {
          ...state.pendingCycles,
          [action.data.taskId]: {
            ...(state.pendingCycles[action.data.taskId] || {}),
            winnerKey: action.data.agentKey,
          },
        },
      }

    case 'result:delivered': {
      // Parse "positive (92%)" → { label: 'positive', confidence: 92 }
      const output  = action.data.output || ''
      const match   = output.match(/^(\w+)\s*\((\d+)%\)/)
      const label      = match ? match[1] : output
      const confidence = match ? parseInt(match[2]) : null

      const pending = state.pendingCycles[action.data.taskId] || {}
      const completedCycle = {
        ...pending,
        taskId:      action.data.taskId,
        winnerKey:   action.data.agentKey,
        winnerRole:  action.data.role,
        label,
        confidence,
        completedAt: action.ts,
        latencyMs:   pending.postedAt ? action.ts - pending.postedAt : null,
      }

      // Only count on-chain inscription txs (from individual labelers, role='labeler-N').
      // The orchestrator batch also fires result:delivered (role='labeler') — skip that duplicate.
      const isInscription = action.data.role && action.data.role !== 'labeler'

      return {
        ...state,
        totalTxs: isInscription ? state.totalTxs + 1 : state.totalTxs,
        agents: {
          ...state.agents,
          [action.data.agentKey]: {
            ...(state.agents[action.data.agentKey] || {}),
            status: 'idle',
            currentTask: null,
            completedTasks: ((state.agents[action.data.agentKey] || {}).completedTasks || 0) + 1,
          },
        },
        results: [
          { ...action.data, ts: action.ts },
          ...state.results,
        ].slice(0, MAX_RESULTS),
        // Move from pending → completed cycles
        cycles: [completedCycle, ...state.cycles].slice(0, MAX_CYCLES),
        pendingCycles: (() => {
          const next = { ...state.pendingCycles }
          delete next[action.data.taskId]
          return next
        })(),
      }
    }

    case 'payment:sent': {
      // Attach txid to the most recent matching cycle
      const cycleIdx = state.cycles.findIndex(c => c.taskId === action.data.taskId)
      let cycles = state.cycles
      if (cycleIdx >= 0) {
        cycles = [...state.cycles]
        cycles[cycleIdx] = { ...cycles[cycleIdx], paymentTxid: action.data.txid, satsPaid: action.data.satsPaid }
      }
      return {
        ...state,
        totalTxs: state.totalTxs + 1,
        cycles,
        payments: [
          { ...action.data, ts: action.ts },
          ...state.payments,
        ].slice(0, MAX_PAYMENTS),
        totalSatsPaid: state.totalSatsPaid + (action.data.satsPaid || 0),
        agents: {
          ...state.agents,
          [action.data.agentKey]: {
            ...(state.agents[action.data.agentKey] || {}),
            totalEarned: ((state.agents[action.data.agentKey] || {}).totalEarned || 0) + (action.data.satsPaid || 0),
          },
        },
      }
    }

    case 'message':
      return {
        ...state,
        messages: [
          { ...action.data, ts: action.ts },
          ...state.messages,
        ].slice(0, MAX_MESSAGES),
      }

    case 'log':
      return {
        ...state,
        logs: [
          { ...action.data, ts: action.ts },
          ...state.logs,
        ].slice(0, MAX_LOGS),
      }

    default:
      return state
  }
}

const INITIAL = {
  agents:        {},
  messages:      [],
  payments:      [],
  results:       [],
  logs:          [],
  cycles:        [],      // completed label cycles for detail view
  pendingCycles: {},      // in-progress cycles keyed by taskId
  totalSatsPaid: 0,
  totalTxs:      0,
  connected:     false,
}

export function useRelay() {
  const [state, dispatch]       = useReducer(reducer, INITIAL)
  const [txPerSec, setTxPerSec] = useState(0)
  const wsRef  = useRef(null)
  const txBuf  = useRef([])

  // Update tx/sec every second from rolling 30s window.
  // 30s smooths out 200ms payment batches and relay-reconnect queue flushes
  // without being so long that it hides real throughput changes.
  useEffect(() => {
    const id = setInterval(() => {
      const now    = Date.now()
      const cutoff = now - 30_000
      txBuf.current = txBuf.current.filter(t => t > cutoff)
      setTxPerSec(+(txBuf.current.length / 30).toFixed(1))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  // Track totalTxs changes → push timestamps
  const prevTxs = useRef(0)
  useEffect(() => {
    const delta = state.totalTxs - prevTxs.current
    if (delta > 0) {
      const now = Date.now()
      for (let i = 0; i < delta; i++) txBuf.current.push(now)
    }
    prevTxs.current = state.totalTxs
  }, [state.totalTxs])

  useEffect(() => {
    let dead = false

    function connect() {
      if (dead) return
      const ws = new WebSocket(RELAY_URL)
      wsRef.current = ws

      ws.onopen = () => {
        ws.send(JSON.stringify({ role: 'subscriber' }))
      }

      ws.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data)
          if (evt.type === 'history') {
            dispatch({ type: 'history', events: evt.events })
          } else {
            dispatch(evt)
          }
        } catch { /* ignore malformed */ }
      }

      ws.onclose = () => { if (!dead) setTimeout(connect, 2000) }
      ws.onerror = () => ws.close()
    }

    connect()
    return () => {
      dead = true
      wsRef.current?.close()
    }
  }, [])

  const projection24h = Math.round(txPerSec * 86400)

  return { ...state, txPerSec, projection24h }
}
