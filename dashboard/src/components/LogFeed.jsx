const ROLE_COLOR = {
  orchestrator: 'var(--accent)',
  researcher:   'var(--green)',
  writer:       'var(--yellow)',
  translator:   'var(--accent2)',
}

function fmt(ts) {
  return new Date(ts).toISOString().slice(11, 19)
}

export default function LogFeed({ logs }) {
  if (logs.length === 0) {
    return (
      <div style={styles.empty}>
        Waiting for agent logs...
      </div>
    )
  }

  return (
    <div style={styles.feed}>
      {logs.map((log, i) => (
        <LogRow key={i} log={log} />
      ))}
    </div>
  )
}

function LogRow({ log }) {
  const color = ROLE_COLOR[log.role] || 'var(--muted)'
  return (
    <div style={styles.row}>
      <span style={styles.time}>{fmt(log.ts)}</span>
      <span style={{ ...styles.role, color }}>{(log.role || '').slice(0, 4).toUpperCase()}</span>
      <span style={styles.msg}>{log.msg}</span>
    </div>
  )
}

const styles = {
  empty: {
    color: 'var(--muted)',
    fontSize: 12,
    padding: 4,
  },
  feed: {
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    overflow: 'auto',
    height: '100%',
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
  },
  row: {
    display: 'flex',
    gap: 8,
    padding: '2px 0',
    borderBottom: '1px solid #ffffff05',
    flexShrink: 0,
    lineHeight: 1.5,
  },
  time: { color: 'var(--muted)', flexShrink: 0, minWidth: 64 },
  role: { fontWeight: 700, flexShrink: 0, minWidth: 36 },
  msg:  { color: 'var(--text)', flex: 1, wordBreak: 'break-word' },
}
