import { useState } from 'react'
import { getPersona } from '../personas.js'

const STATUS_COLOR = {
  idle:    'var(--muted)',
  bidding: 'var(--accent)',
  working: 'var(--yellow)',
  offline: 'var(--red)',
}

export default function AgentGrid({ agents, cycles = [] }) {
  const [selected, setSelected] = useState(null)

  if (agents.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={{ fontSize: 24, opacity: 0.3 }}>◌</div>
        <div>Waiting for agents...</div>
      </div>
    )
  }

  const selectedAgent = selected ? agents.find(a => a.agentKey === selected) : null
  const agentCycles   = selectedAgent
    ? cycles.filter(c => c.winnerKey === selected)
    : []

  return (
    <>
      <div style={styles.grid}>
        {agents.map(agent => (
          <AgentCard
            key={agent.agentKey}
            agent={agent}
            onClick={() => setSelected(agent.agentKey)}
          />
        ))}
      </div>

      {selected && selectedAgent && (
        <AgentModal
          agent={selectedAgent}
          cycles={agentCycles}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}

// ── Card ─────────────────────────────────────────────────────────────────────

function AgentCard({ agent, onClick }) {
  const persona     = getPersona(agent.agentKey)
  const statusColor = STATUS_COLOR[agent.status] || 'var(--muted)'
  const isOrch      = agent.role === 'orchestrator'
  const borderColor = agent.online
    ? (isOrch ? 'var(--accent)' : 'var(--green)') + '55'
    : 'var(--border)'

  const name  = isOrch ? 'Nexus' : (persona?.name || agent.label || 'Agent')
  const emoji = persona?.emoji || (isOrch ? '⬡' : '◆')
  const trait = persona?.trait || ''

  return (
    <div
      style={{ ...styles.card, borderColor, cursor: 'pointer' }}
      onClick={onClick}
    >
      {/* Row 1: emoji + name + status dot */}
      <div style={styles.top}>
        <span style={styles.emoji}>{emoji}</span>
        <span style={{ ...styles.name, color: isOrch ? 'var(--accent)' : 'var(--green)' }}>
          {name}
        </span>
        <span style={{ ...styles.dot, background: agent.online ? statusColor : 'var(--red)' }} />
      </div>

      {/* Row 2: status + stats */}
      <div style={styles.bottom}>
        <span style={{ ...styles.statusText, color: statusColor }}>
          {agent.online ? (agent.status || 'idle') : 'offline'}
        </span>
        <div style={styles.badges}>
          {agent.bidsWon > 0 && (
            <span style={{ ...styles.badge, color: 'var(--accent)' }}>⚡{agent.bidsWon}</span>
          )}
          {agent.completedTasks > 0 && (
            <span style={{ ...styles.badge, color: 'var(--green)' }}>✓{agent.completedTasks}</span>
          )}
          {agent.totalEarned > 0 && (
            <span style={{ ...styles.badge, color: 'var(--accent2)' }}>{agent.totalEarned}s</span>
          )}
        </div>
      </div>

      {/* Row 3: trait */}
      {trait && (
        <div style={styles.trait}>{trait}</div>
      )}
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function AgentModal({ agent, cycles, onClose }) {
  const persona  = getPersona(agent.agentKey)
  const isOrch   = agent.role === 'orchestrator'
  const name     = isOrch ? 'Nexus' : (persona?.name || agent.label || 'Agent')
  const emoji    = persona?.emoji || (isOrch ? '⬡' : '◆')
  const trait    = persona?.trait || ''
  const accentColor = isOrch ? 'var(--accent)' : 'var(--green)'
  const statusColor = STATUS_COLOR[agent.status] || 'var(--muted)'

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>

        {/* Close button */}
        <button style={styles.closeBtn} onClick={onClose}>✕</button>

        {/* Avatar */}
        <div style={{ ...styles.avatarRing, borderColor: accentColor }}>
          <span style={styles.avatarEmoji}>{emoji}</span>
        </div>

        {/* Name + trait */}
        <div style={{ ...styles.modalName, color: accentColor }}>{name}</div>
        {trait && <div style={styles.modalTrait}>{trait}</div>}

        {/* Status pill */}
        <div style={{ ...styles.statusPill, background: agent.online ? statusColor : 'var(--red)' }}>
          {agent.online ? (agent.status || 'idle') : 'offline'}
        </div>

        {/* Stats row */}
        <div style={styles.statsRow}>
          <ModalStat label="Bids Won"   value={agent.bidsWon       || 0} color="var(--accent)"  />
          <ModalStat label="Tasks Done" value={agent.completedTasks || 0} color="var(--green)"   />
          <ModalStat label="Sats Earned" value={agent.totalEarned  || 0} color="var(--accent2)" />
        </div>

        {/* Task history */}
        <div style={styles.historyHeader}>
          Recent Tasks Won
          <span style={styles.historyCount}>{cycles.length}</span>
        </div>

        <div style={styles.historyList}>
          {cycles.length === 0 ? (
            <div style={styles.historyEmpty}>No tasks won yet</div>
          ) : (
            cycles.slice(0, 100).map((c, i) => (
              <div key={i} style={styles.historyItem}>
                <span style={styles.historyLabel(c.label)}>
                  {c.label || '—'}
                </span>
                <span style={styles.historyConf}>
                  {c.confidence != null ? `${c.confidence}%` : ''}
                </span>
                <span style={styles.historyText}>{c.text?.slice(0, 60) || ''}</span>
                {c.latencyMs != null && (
                  <span style={styles.historyLatency}>{c.latencyMs}ms</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ModalStat({ label, value, color }) {
  return (
    <div style={styles.modalStat}>
      <div style={{ ...styles.modalStatValue, color }}>{value.toLocaleString()}</div>
      <div style={styles.modalStatLabel}>{label}</div>
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const LABEL_COLORS = {
  positive: 'var(--green)',
  negative: 'var(--red)',
  neutral:  'var(--muted)',
  mixed:    'var(--yellow)',
}

const styles = {
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', padding: '16px 0',
    gap: 6, color: 'var(--muted)', fontSize: 12,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 5,
  },
  card: {
    background: 'var(--bg)', border: '1px solid',
    borderRadius: 6, padding: '6px 8px',
    display: 'flex', flexDirection: 'column', gap: 3,
    minWidth: 0,
    transition: 'opacity 0.1s',
  },
  top: {
    display: 'flex', alignItems: 'center', gap: 5,
  },
  bottom: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4,
  },
  emoji: { fontSize: 13, lineHeight: 1, flexShrink: 0 },
  name: {
    fontSize: 11, fontWeight: 700, flex: 1,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  dot: {
    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
  },
  statusText: {
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3,
  },
  badges: { display: 'flex', gap: 5, alignItems: 'center' },
  badge: {
    fontSize: 9, fontFamily: 'var(--font-mono)', fontWeight: 700,
  },
  trait: {
    fontSize: 9, color: 'var(--muted)', fontStyle: 'italic',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },

  // Modal overlay
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 1000,
    backdropFilter: 'blur(4px)',
  },
  modal: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '28px 24px 20px',
    width: 360,
    maxHeight: '80vh',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    position: 'relative',
    overflow: 'hidden',
  },
  closeBtn: {
    position: 'absolute', top: 10, right: 12,
    background: 'none', border: 'none', cursor: 'pointer',
    color: 'var(--muted)', fontSize: 14, lineHeight: 1,
    padding: 4,
  },

  // Avatar
  avatarRing: {
    width: 72, height: 72,
    borderRadius: '50%',
    border: '2px solid',
    background: 'var(--bg)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  avatarEmoji: { fontSize: 36, lineHeight: 1 },

  modalName: {
    fontSize: 18, fontWeight: 700,
    fontFamily: 'var(--font-mono)',
    letterSpacing: 0.5,
  },
  modalTrait: {
    fontSize: 11, color: 'var(--muted)', fontStyle: 'italic',
    textAlign: 'center',
  },
  statusPill: {
    fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1,
    padding: '2px 8px', borderRadius: 10, color: 'var(--bg)',
  },

  // Stats
  statsRow: {
    display: 'flex', gap: 20,
    padding: '8px 0',
    borderTop: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
    width: '100%',
    justifyContent: 'center',
  },
  modalStat: { textAlign: 'center' },
  modalStatValue: {
    fontSize: 20, fontWeight: 700,
    fontFamily: 'var(--font-mono)', lineHeight: 1,
  },
  modalStatLabel: {
    fontSize: 9, color: 'var(--muted)', marginTop: 3,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },

  // Task history
  historyHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    fontSize: 10, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: 1, color: 'var(--muted)',
    width: '100%',
  },
  historyCount: {
    background: 'var(--bg)', borderRadius: 8,
    padding: '1px 6px', fontSize: 9,
    color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontWeight: 700,
  },
  historyList: {
    width: '100%', overflowY: 'auto',
    flex: 1, display: 'flex', flexDirection: 'column', gap: 3,
    maxHeight: 260,
  },
  historyEmpty: {
    textAlign: 'center', color: 'var(--muted)', fontSize: 11,
    padding: '16px 0',
  },
  historyItem: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'var(--bg)', borderRadius: 4,
    padding: '4px 8px', fontSize: 10,
    flexShrink: 0,
  },
  historyLabel: (label) => ({
    fontWeight: 700, fontFamily: 'var(--font-mono)',
    color: LABEL_COLORS[label] || 'var(--muted)',
    minWidth: 52, textTransform: 'capitalize',
  }),
  historyConf: {
    color: 'var(--muted)', fontFamily: 'var(--font-mono)',
    fontSize: 9, minWidth: 30,
  },
  historyText: {
    flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    color: 'var(--text)', fontSize: 9,
  },
  historyLatency: {
    color: 'var(--yellow)', fontFamily: 'var(--font-mono)',
    fontSize: 9, flexShrink: 0,
  },
}
