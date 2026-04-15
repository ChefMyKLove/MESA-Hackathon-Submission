import { getPersona } from '../personas.js'

const LABEL_COLOR = {
  positive: 'var(--green)',
  negative: 'var(--red)',
  neutral:  'var(--muted)',
}

const WOC = 'https://whatsonchain.com/tx/'

export default function LabelingDetail({ cycles, agents }) {
  if (cycles.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyIcon}>◌</div>
        <div>Waiting for completed label cycles…</div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          Each row = one task · three on-chain BSV transactions
        </div>
      </div>
    )
  }

  // Leaderboard: rank agents by wins
  const agentList = Object.values(agents).filter(a => a.role !== 'orchestrator')
  agentList.sort((a, b) => (b.bidsWon || 0) - (a.bidsWon || 0))

  return (
    <div style={styles.root}>

      {/* ── Leaderboard ── */}
      <div style={styles.leaderboard}>
        <div style={styles.lbTitle}>Agent Leaderboard</div>
        <div style={styles.lbGrid}>
          {agentList.map((agent, i) => {
            const persona = getPersona(agent.agentKey)
            const winRate = agent.bidsWon && cycles.length
              ? ((agent.bidsWon / cycles.length) * 100).toFixed(0)
              : 0
            return (
              <div key={agent.agentKey} style={styles.lbCard}>
                <div style={styles.lbRank}>#{i + 1}</div>
                <div style={styles.lbEmoji}>{persona?.emoji || '◆'}</div>
                <div style={styles.lbName}>{persona?.name || 'Agent'}</div>
                <div style={styles.lbTrait}>{persona?.trait || ''}</div>
                <div style={styles.lbStats}>
                  <span style={{ color: 'var(--green)' }}>⚡ {agent.bidsWon || 0} wins</span>
                  <span style={{ color: 'var(--muted)' }}> · {winRate}% rate</span>
                  {agent.totalEarned > 0 && (
                    <span style={{ color: 'var(--accent2)' }}> · {agent.totalEarned} sats</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Detail table ── */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              {['#', 'Task', 'Text', 'Winner', 'Label', 'Conf', 'Latency', 'Bidders', 'Payment Tx'].map(h => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cycles.map((cycle, i) => {
              const persona    = getPersona(cycle.winnerKey)
              const labelColor = LABEL_COLOR[cycle.label] || 'var(--text)'
              const timeStr    = cycle.completedAt
                ? new Date(cycle.completedAt).toLocaleTimeString()
                : ''

              return (
                <tr key={cycle.taskId} style={{
                  ...styles.tr,
                  background: i % 2 === 0 ? 'var(--surface)' : 'var(--bg)',
                }}>
                  {/* Row # */}
                  <td style={{ ...styles.td, ...styles.tdMono, color: 'var(--muted)', width: 40 }}>
                    {cycles.length - i}
                  </td>

                  {/* Task ID */}
                  <td style={{ ...styles.td, ...styles.tdMono, color: 'var(--muted)', fontSize: 10, width: 90 }}>
                    {cycle.taskId}
                    {timeStr && <div style={{ fontSize: 9, color: 'var(--border)' }}>{timeStr}</div>}
                  </td>

                  {/* Text snippet */}
                  <td style={{ ...styles.td, maxWidth: 300 }}>
                    <div style={styles.textSnippet} title={cycle.text}>
                      {cycle.text || '—'}
                    </div>
                  </td>

                  {/* Winner */}
                  <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                    {persona ? (
                      <span>
                        <span style={{ marginRight: 4 }}>{persona.emoji}</span>
                        <span style={{ fontWeight: 700, color: 'var(--text)' }}>{persona.name}</span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--muted)', fontSize: 10 }}>
                        {(cycle.winnerRole || cycle.winnerKey || '—')}
                      </span>
                    )}
                  </td>

                  {/* Label */}
                  <td style={{ ...styles.td, ...styles.tdMono }}>
                    <span style={{
                      color: labelColor,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      fontSize: 10,
                      letterSpacing: 0.5,
                    }}>
                      {cycle.label || '—'}
                    </span>
                  </td>

                  {/* Confidence */}
                  <td style={{ ...styles.td, ...styles.tdMono, textAlign: 'right', width: 50 }}>
                    {cycle.confidence != null ? (
                      <span style={{ color: cycle.confidence >= 80 ? 'var(--green)' : 'var(--yellow)' }}>
                        {cycle.confidence}%
                      </span>
                    ) : '—'}
                  </td>

                  {/* Latency */}
                  <td style={{ ...styles.td, ...styles.tdMono, textAlign: 'right', width: 70, color: 'var(--muted)' }}>
                    {cycle.latencyMs != null ? `${cycle.latencyMs}ms` : '—'}
                  </td>

                  {/* Bidder count */}
                  <td style={{ ...styles.td, textAlign: 'center', width: 60 }}>
                    <span style={{
                      background: 'var(--border)', borderRadius: 10,
                      padding: '1px 7px', fontSize: 10, fontFamily: 'var(--font-mono)',
                    }}>
                      {(cycle.bidders || []).length || '?'}
                    </span>
                  </td>

                  {/* Payment tx */}
                  <td style={{ ...styles.td, ...styles.tdMono, fontSize: 10, width: 120 }}>
                    {cycle.paymentTxid ? (
                      <a
                        href={WOC + cycle.paymentTxid}
                        target="_blank"
                        rel="noreferrer"
                        style={styles.txLink}
                        title={cycle.paymentTxid}
                      >
                        {cycle.paymentTxid.slice(0, 12)}…
                      </a>
                    ) : (
                      <span style={{ color: 'var(--muted)' }}>pending</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const styles = {
  root: {
    display: 'flex', flexDirection: 'column',
    height: '100%', overflow: 'hidden',
  },

  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100%', gap: 8,
    color: 'var(--muted)', fontSize: 13,
  },
  emptyIcon: { fontSize: 32, opacity: 0.4 },

  // Leaderboard
  leaderboard: {
    padding: '10px 16px 8px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
  },
  lbTitle: {
    fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: 1, color: 'var(--muted)', marginBottom: 8,
  },
  lbGrid: {
    display: 'flex', gap: 8, flexWrap: 'wrap',
  },
  lbCard: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 8, padding: '6px 10px',
    display: 'flex', flexDirection: 'column', gap: 2,
    minWidth: 140,
  },
  lbRank: { fontSize: 9, color: 'var(--muted)', fontFamily: 'var(--font-mono)' },
  lbEmoji: { fontSize: 18, lineHeight: 1 },
  lbName: { fontSize: 13, fontWeight: 700, color: 'var(--text)' },
  lbTrait: { fontSize: 9, color: 'var(--muted)', fontStyle: 'italic' },
  lbStats: { fontSize: 10, fontFamily: 'var(--font-mono)', marginTop: 2 },

  // Table
  tableWrap: {
    flex: 1, overflow: 'auto',
  },
  table: {
    width: '100%', borderCollapse: 'collapse',
    fontSize: 12, tableLayout: 'fixed',
  },
  th: {
    position: 'sticky', top: 0, zIndex: 1,
    background: 'var(--bg)',
    padding: '6px 10px',
    textAlign: 'left',
    fontSize: 9, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: 0.5,
    color: 'var(--muted)',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  },
  tr: {
    borderBottom: '1px solid var(--border)',
  },
  td: {
    padding: '5px 10px',
    verticalAlign: 'middle',
    color: 'var(--text)',
    overflow: 'hidden',
  },
  tdMono: {
    fontFamily: 'var(--font-mono)',
  },
  textSnippet: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: 11,
    color: 'var(--text)',
  },
  txLink: {
    color: 'var(--accent)',
    textDecoration: 'none',
    fontFamily: 'var(--font-mono)',
  },
}
