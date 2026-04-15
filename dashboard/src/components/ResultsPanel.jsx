import { useState } from 'react'

const ROLE_COLOR = {
  researcher: 'var(--green)',
  writer:     'var(--yellow)',
  translator: 'var(--accent2)',
}

export default function ResultsPanel({ results }) {
  const [expanded, setExpanded] = useState(null)

  if (results.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={{ opacity: 0.3, fontSize: 20 }}>◌</div>
        <div>No results yet — jobs in progress...</div>
      </div>
    )
  }

  return (
    <div style={styles.list}>
      {results.map((r, i) => {
        const isOpen = expanded === i
        const color = ROLE_COLOR[r.role] || 'var(--muted)'
        return (
          <div key={i} style={{ ...styles.item, borderLeft: `2px solid ${color}` }}>
            <div style={styles.header} onClick={() => setExpanded(isOpen ? null : i)}>
              <span style={{ ...styles.role, color }}>{r.role}</span>
              <span style={styles.task}>{r.taskId?.split('_').slice(-2).join('_')}</span>
              <span style={styles.toggle}>{isOpen ? '▲' : '▼'}</span>
            </div>
            {isOpen && (
              <div style={styles.output}>{r.output}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const styles = {
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    color: 'var(--muted)',
    fontSize: 12,
    height: '100%',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    overflow: 'auto',
    maxHeight: 180,
  },
  item: {
    background: 'var(--bg)',
    borderRadius: 4,
    overflow: 'hidden',
    flexShrink: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  role: {
    fontWeight: 700,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    minWidth: 72,
  },
  task: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--muted)',
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toggle: {
    fontSize: 10,
    color: 'var(--muted)',
  },
  output: {
    padding: '8px 10px',
    fontSize: 11,
    lineHeight: 1.6,
    color: 'var(--text)',
    borderTop: '1px solid var(--border)',
    whiteSpace: 'pre-wrap',
    maxHeight: 200,
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
  },
}
