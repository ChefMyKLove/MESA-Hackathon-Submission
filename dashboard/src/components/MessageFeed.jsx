function fmt(ts) {
  return new Date(ts).toISOString().slice(11, 19)
}

function shortKey(key) {
  if (!key) return '???'
  return key.slice(0, 8) + '…'
}

const TYPE_STYLE = {
  job:     { label: 'JOB',     bg: '#003344', color: 'var(--accent)',  border: 'var(--accent)' },
  bid:     { label: 'BID',     bg: '#1a1500', color: 'var(--yellow)', border: 'var(--yellow)' },
  award:   { label: 'AWARD',   bg: '#1a0028', color: 'var(--accent2)',border: 'var(--accent2)' },
  message: { label: 'MSG',     bg: '#0a0f1a', color: 'var(--muted)',  border: 'var(--border)' },
}

export default function MessageFeed({ messages }) {
  if (messages.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={{ fontSize: 24, opacity: 0.3 }}>◌</div>
        <div>Waiting for messages...</div>
      </div>
    )
  }

  return (
    <div style={styles.feed}>
      {messages.map((msg, i) => (
        <MessageRow key={i} msg={msg} />
      ))}
    </div>
  )
}

function MessageRow({ msg }) {
  let kind = 'message'
  if (msg._isJob)   kind = 'job'
  if (msg._isBid)   kind = 'bid'
  if (msg._isAward) kind = 'award'

  const s = TYPE_STYLE[kind]

  let summary = ''
  if (kind === 'job') {
    summary = `[${msg.taskType?.toUpperCase()}] ${(msg.prompt || '').slice(0, 60)}`
  } else if (kind === 'bid') {
    summary = `${msg.role} bids ${msg.bidSats} sats`
  } else if (kind === 'award') {
    summary = `${msg.role} awarded @ ${msg.agreedSats} sats`
  } else {
    const box = msg.box ? ` → ${msg.box}` : ''
    summary = `${shortKey(msg.from)}${box}`
  }

  return (
    <div style={{ ...styles.row, background: s.bg, borderLeft: `2px solid ${s.border}` }}>
      <span style={{ ...styles.badge, color: s.color }}>{s.label}</span>
      <span style={styles.time}>{fmt(msg.ts)}</span>
      <span style={styles.summary}>{summary}</span>
    </div>
  )
}

const styles = {
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 8,
    color: 'var(--muted)',
    fontSize: 13,
  },
  feed: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    overflow: 'auto',
    height: '100%',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '5px 8px',
    borderRadius: 4,
    fontSize: 12,
    flexShrink: 0,
  },
  badge: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    fontWeight: 700,
    minWidth: 42,
  },
  time: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--muted)',
    flexShrink: 0,
  },
  summary: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'var(--text)',
  },
}
