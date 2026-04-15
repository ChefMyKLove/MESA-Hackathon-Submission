function fmt(ts) {
  return new Date(ts).toISOString().slice(11, 19)
}

export default function PaymentStream({ payments }) {
  if (payments.length === 0) {
    return (
      <div style={styles.empty}>
        <span style={{ opacity: 0.3 }}>₿</span> No payments yet
      </div>
    )
  }

  return (
    <div style={styles.list}>
      {payments.map((p, i) => (
        <PaymentRow key={i} p={p} />
      ))}
    </div>
  )
}

function PaymentRow({ p }) {
  const txShort = (p.txid || '').slice(0, 24) + '…'

  return (
    <div style={styles.row}>
      <span style={styles.sats}>+{p.satsPaid} <span style={styles.unit}>sats</span></span>
      <span style={styles.time}>{fmt(p.ts)}</span>
      <span style={styles.txid} title={p.txid}>{txShort}</span>
    </div>
  )
}

const styles = {
  empty: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    color: 'var(--muted)',
    fontSize: 13,
    height: '100%',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    overflow: 'auto',
    maxHeight: 140,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '4px 8px',
    background: '#001a0a',
    border: '1px solid #00301500',
    borderLeft: '2px solid var(--green)',
    borderRadius: 4,
    fontSize: 12,
  },
  sats: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    color: 'var(--green)',
    minWidth: 70,
  },
  unit: { fontSize: 10, fontWeight: 400 },
  time: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--muted)',
    flexShrink: 0,
  },
  txid: {
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    color: 'var(--muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
}
