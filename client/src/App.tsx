import { useEffect, useState } from 'react'
import { api, setActiveOrg } from './api'
import type { Role, Session } from './types'
import { Dialer } from './components/Dialer'
import { ImportView } from './components/ImportView'
import { LeadManager } from './components/LeadManager'
import { Login } from './components/Login'
import { MetricsView } from './components/MetricsView'
import { SetupView } from './components/SetupView'
import { TranscriptsView } from './components/TranscriptsView'
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher'
import { useTheme } from './hooks/useTheme'

type Tab = 'dial' | 'leads' | 'metrics' | 'transcripts' | 'import' | 'setup'

// One flat nav instead of an Admin page holding four unrelated tools. Each of these
// is a separate job — working the queue, cleaning the list, reading the numbers,
// reviewing calls, loading a CSV — and stacking them on one page meant scrolling
// past three to reach the fourth. A caller reads their own workspace's Metrics and
// Transcripts; changing the list is the owner's job.
const TABS: { id: Tab; label: string; ownerOnly?: boolean }[] = [
  { id: 'dial', label: 'Dial' },
  { id: 'leads', label: 'Leads', ownerOnly: true },
  { id: 'metrics', label: 'Metrics' },
  { id: 'transcripts', label: 'Transcripts' },
  { id: 'import', label: 'Import', ownerOnly: true },
  { id: 'setup', label: 'Setup' },
]

function visibleTabs(role: Role) {
  return TABS.filter((tab) => !tab.ownerOnly || role === 'owner')
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('dial')
  const [callBusy, setCallBusy] = useState(false)
  const { theme, toggle } = useTheme()

  function start(next: Session) {
    setActiveOrg(next.org.id)
    setSession(next)
  }

  useEffect(() => {
    api
      .me()
      .then(start)
      .catch(() => setSession(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="muted">Loading…</div>
      </div>
    )
  }

  if (!session) return <Login onLogin={start} />

  const { user, org, orgs } = session
  const tabs = visibleTabs(org.role)
  // The caller signing in on a tab only the owner can see would get a blank page
  // rather than an error, so fall back to the dialer.
  const active = tabs.some((t) => t.id === tab) ? tab : 'dial'

  return (
    <div className="app">
      <div className="topbar">
        <h1>DialDesk</h1>
        {__DEMO__ && (
          <span className="badge purple demo-badge" title="Fictional data. No calls are placed and nothing leaves this browser.">
            demo
          </span>
        )}
        {orgs.length > 1 && <WorkspaceSwitcher current={org} orgs={orgs} disabled={callBusy} />}
        <nav className="tabs">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={active === t.id ? 'primary' : ''}
              onClick={(e) => {
                setTab(t.id)
                e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })
              }}
              disabled={callBusy && active !== t.id}
              title={callBusy && active !== t.id ? 'Finish the call first' : undefined}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button
          className="theme-toggle"
          onClick={toggle}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
        <span className="muted user-label">
          {user.displayName} · {org.role}
        </span>
        <button
          disabled={callBusy}
          onClick={async () => {
            await api.logout()
            setActiveOrg(null)
            setSession(null)
          }}
        >
          Sign out
        </button>
      </div>

      {active === 'dial' && <Dialer orgId={org.id} onCallActiveChange={setCallBusy} />}
      {active === 'leads' && (
        <LeadManager
          targets={orgs.filter((o) => o.id !== org.id && o.role === 'owner')}
          orgNames={Object.fromEntries(orgs.map((o) => [o.id, o.name]))}
        />
      )}
      {active === 'metrics' && <MetricsView />}
      {active === 'transcripts' && <TranscriptsView />}
      {active === 'import' && <ImportView workspace={org.name} />}
      {active === 'setup' && <SetupView />}
    </div>
  )
}
