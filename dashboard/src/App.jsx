import { useState } from 'react'
import { useRelay } from './useRelay.js'
import AgentGrid from './components/AgentGrid.jsx'
import MessageFeed from './components/MessageFeed.jsx'
import PaymentStream from './components/PaymentStream.jsx'
import ResultsPanel from './components/ResultsPanel.jsx'
import LogFeed from './components/LogFeed.jsx'
import LabelingDetail from './components/LabelingDetail.jsx'

export default function App() {
  const [activeTab, setActiveTab] = useState('overview')

  const {
    agents, messages, payments, results, logs, cycles,
    totalSatsPaid, totalTxs, txPerSec, projection24h,
  } = useRelay()

  const agentList = Object.values(agents).sort((a, b) => {
    if (a.role === 'orchestrator') return -1
    if (b.role === 'orchestrator') return 1
    return (a.label || '').localeCompare(b.label || '')
  })

  const onlineCount  = agentList.filter(a => a.online).length
  const isConnected  = onlineCount > 0
  const TARGET_TX_DAY = 1_500_000
  const progress     = Math.min(100, (projection24h / TARGET_TX_DAY) * 100).toFixed(0)

  return (
    <div style={styles.root}>

      {/* ── Header ── */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>
            <span style={{ color: 'var(--accent)' }}>M</span>
            <span style={{ color: 'var(--accent2)' }}>E</span>
            <span style={{ color: 'var(--green)' }}>S</span>
            <span style={{ color: 'var(--yellow)' }}>A</span>
          </div>
          <div>
            <div style={styles.tagline}>Multi-Agent Escrow &amp; Skills Auction</div>
            <div style={styles.subtitle}>AI data labeling · BSV micropayments · on-chain</div>
          </div>

          {/* ── Tab toggle ── */}
          <div style={styles.tabs}>
            <Tab label="Overview"   active={activeTab === 'overview'} onClick={() => setActiveTab('overview')} />
            <Tab
              label={`Detail ${cycles.length > 0 ? `(${cycles.length})` : ''}`}
              active={activeTab === 'detail'}
              onClick={() => setActiveTab('detail')}
              accent="var(--green)"
            />
          </div>
        </div>

        <div style={styles.headerRight}>
          <Stat label="Agents Online"  value={onlineCount}                    color="var(--green)"   />
          <Stat label="Total Txs"      value={totalTxs.toLocaleString()}       color="var(--accent)"  />
          <Stat label="Tx / sec"       value={txPerSec.toFixed(1)}             color="var(--yellow)"  />
          <Stat label="24h Projection" value={projection24h.toLocaleString()}  color="var(--accent2)" />
          <Stat label="Sats Paid"      value={totalSatsPaid.toLocaleString()}  color="var(--green)"   />

          <div style={styles.targetWrap}>
            <div style={styles.targetLabel}>{progress}% of 1.5M target</div>
            <div style={styles.barBg}>
              <div style={{
                ...styles.barFill,
                width: `${progress}%`,
                background: Number(progress) >= 100 ? 'var(--green)' : 'var(--accent)',
              }} />
            </div>
          </div>

          <div style={{
            ...styles.dot,
            background: isConnected ? 'var(--green)' : 'var(--red)',
          }} title={isConnected ? 'Connected' : 'Disconnected'} />
        </div>
      </header>

      {/* ── Overview tab ── */}
      {activeTab === 'overview' && (
        <main style={styles.main}>
          <div style={styles.leftCol}>
            <Section title={`Agents (${onlineCount}/11)`} accent="var(--accent)" grow={false}>
              <AgentGrid agents={agentList} cycles={cycles} />
            </Section>
            <Section title="Labeled Results" accent="var(--green)">
              <ResultsPanel results={results} />
            </Section>
            <Section title="Payments" accent="var(--accent2)" grow={false}>
              <PaymentStream payments={payments} />
            </Section>
          </div>

          <div style={styles.rightCol}>
            <Section title="Auction Feed" accent="var(--yellow)" grow>
              <MessageFeed messages={messages} />
            </Section>
            <Section title="Agent Logs" accent="var(--muted)" grow>
              <LogFeed logs={logs} />
            </Section>
          </div>
        </main>
      )}

      {/* ── Detail tab ── */}
      {activeTab === 'detail' && (
        <div style={styles.detailPane}>
          <LabelingDetail cycles={cycles} agents={agents} />
        </div>
      )}
    </div>
  )
}

function Tab({ label, active, onClick, accent = 'var(--accent)' }) {
  return (
    <button onClick={onClick} style={{
      ...styles.tab,
      color:       active ? accent : 'var(--muted)',
      borderBottom: active ? `2px solid ${accent}` : '2px solid transparent',
      fontWeight:  active ? 700 : 400,
    }}>
      {label}
    </button>
  )
}

function Section({ title, accent, children, grow = true }) {
  return (
    <div style={{ ...styles.section, ...(grow ? styles.sectionGrow : {}) }}>
      <div style={styles.sectionHeader}>
        <div style={{ ...styles.sectionDot, background: accent }} />
        <span style={styles.sectionTitle}>{title}</span>
      </div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  )
}

function Stat({ label, value, color }) {
  return (
    <div style={styles.stat}>
      <div style={{ ...styles.statValue, color }}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
    </div>
  )
}

const styles = {
  root: {
    display: 'flex', flexDirection: 'column',
    height: '100vh', overflow: 'hidden',
    background: 'var(--bg)',
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '10px 20px', borderBottom: '1px solid var(--border)',
    background: 'var(--surface)', flexShrink: 0,
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 16 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 20 },
  logo: {
    display: 'flex', fontFamily: 'var(--font-mono)',
    fontSize: 26, fontWeight: 700, letterSpacing: 3,
  },
  tagline: { fontSize: 13, fontWeight: 600, color: 'var(--text)' },
  subtitle: { fontSize: 10, color: 'var(--muted)' },

  // Tabs
  tabs: { display: 'flex', gap: 2, marginLeft: 8 },
  tab: {
    background: 'none', border: 'none', borderBottom: '2px solid transparent',
    cursor: 'pointer', fontSize: 12, padding: '4px 12px',
    fontFamily: 'var(--font-mono)', letterSpacing: 0.5,
    transition: 'color 0.15s, border-color 0.15s',
  },

  dot: { width: 9, height: 9, borderRadius: '50%', flexShrink: 0 },
  stat: { textAlign: 'right' },
  statValue: { fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', lineHeight: 1 },
  statLabel: { fontSize: 9, color: 'var(--muted)', marginTop: 2, textTransform: 'uppercase', letterSpacing: 0.5 },
  targetWrap: { textAlign: 'right', minWidth: 110 },
  targetLabel: { fontSize: 9, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  barBg: { height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 2, transition: 'width 1s ease' },

  // Overview layout
  main: {
    display: 'flex', flex: 1, overflow: 'hidden',
    gap: 1, background: 'var(--border)',
  },
  leftCol: {
    display: 'flex', flexDirection: 'column',
    width: 700, flexShrink: 0,
    background: 'var(--bg)', gap: 1,
  },
  rightCol: {
    display: 'flex', flexDirection: 'column',
    flex: 1, background: 'var(--bg)', gap: 1, minWidth: 0,
  },
  section: {
    display: 'flex', flexDirection: 'column',
    background: 'var(--surface)', overflow: 'hidden',
  },
  sectionGrow: { flex: 1, minHeight: 0 },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0,
  },
  sectionDot: { width: 6, height: 6, borderRadius: '50%' },
  sectionTitle: {
    fontSize: 10, fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: 1, color: 'var(--muted)',
  },
  sectionBody: { flex: 1, overflow: 'hidden', padding: 10 },

  // Detail pane
  detailPane: {
    flex: 1, overflow: 'hidden',
    background: 'var(--bg)',
  },
}
