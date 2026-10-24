import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useMicName } from '../hooks/useMicName'
import { useDevice } from '../hooks/useDevice'
import { useResizableSidebar } from '../hooks/useResizableSidebar'
import { useWakeLock } from '../hooks/useWakeLock'
import { canTranscribeHere, NARROW_QUERY } from '../lib/platform'
import type { CallHistoryEntry, CallWindow, Disposition, Facets, Lead, LeadFilters as Filters } from '../types'
import { CallPanel } from './CallPanel'
import { IncomingCallBanner } from './IncomingCallBanner'
import { LeadCard } from './LeadCard'
import { MobileCallBar } from './MobileCallBar'
import { Queue } from './Queue'
import { ScriptPanel } from './ScriptPanel'

type MobileView = 'queue' | 'script' | 'lead' | 'call'

const MOBILE_VIEWS: { id: MobileView; label: string }[] = [
  { id: 'queue', label: 'Queue' },
  { id: 'script', label: 'Script' },
  { id: 'lead', label: 'Lead' },
  { id: 'call', label: 'Call' },
]

export function Dialer({ orgId, onCallActiveChange }: { orgId: string; onCallActiveChange?: (active: boolean) => void }) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [total, setTotal] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>({ view: 'queue', limit: 50, offset: 0 })
  const [offset, setOffset] = useState(0)
  const [facets, setFacets] = useState<Facets | null>(null)
  const [callWindow, setCallWindow] = useState<CallWindow | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<CallHistoryEntry[]>([])
  // Both come from the server: the signed-in person's own name and their workspace's number.
  const [callerName, setCallerName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [callbackNumber, setCallbackNumber] = useState<string | null>(null)

  const dialerRef = useRef<HTMLDivElement>(null)
  const sidebar = useResizableSidebar(dialerRef)

  const device = useDevice({ preload: canTranscribeHere, orgId })
  const micLabel = useMicName(device.callMic, device.phase)
  const activeLead = leads.find((l) => l.id === activeId) ?? null

  // On a phone the three columns become one view at a time, switched from a tab strip.
  const narrow = useMediaQuery(NARROW_QUERY)
  const [mobileView, setMobileView] = useState<MobileView>('script')
  const showScript = useCallback(() => {
    if (narrow) setMobileView('script')
  }, [narrow])

  const callActive = device.phase !== 'idle' || device.inbound !== null
  useWakeLock(callActive)

  // Leaving the Dial tab unmounts the device and drops the call, so the nav is locked meanwhile.
  useEffect(() => {
    onCallActiveChange?.(callActive)
  }, [callActive, onCallActiveChange])
  useEffect(() => () => onCallActiveChange?.(false), [onCallActiveChange])

  // The outcome buttons live in the Call view; jump there the moment one is needed.
  useEffect(() => {
    if (narrow && device.phase === 'ended') setMobileView('call')
  }, [narrow, device.phase])

  const loadQueue = useCallback(
    async (keepActive = true) => {
      try {
        const data = await api.queue(filters)
        setLeads(data.leads)
        setTotal(data.total)
        setOffset(data.offset)
        setCallWindow(data.callWindow)
        setCallerName(data.callerName)
        setCompanyName(data.companyName)
        setCallbackNumber(data.callbackNumber ?? null)
        setLoadError(null)
        setActiveId((current) => {
          if (keepActive && current && data.leads.some((l) => l.id === current)) return current
          return data.leads[0]?.id ?? null
        })
      } catch (err) {
        setLoadError((err as Error).message)
      }
    },
    [filters],
  )

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  useEffect(() => {
    api.facets().then(setFacets).catch(() => setFacets(null))
  }, [])

  // Past attempts on the selected lead. Fetched separately because the queue
  // response deliberately stays light — 100 leads with 5 calls each is a lot of
  // payload the caller can only look at one lead of.
  useEffect(() => {
    if (!activeId) {
      setHistory([])
      return
    }
    let stale = false
    api
      .leadDetail(activeId)
      .then(({ calls }) => {
        if (!stale) setHistory(calls)
      })
      .catch(() => {
        if (!stale) setHistory([])
      })
    return () => {
      stale = true
    }
  }, [activeId])

  // Keep the window banner honest during a long shift without re-ordering the queue
  // under the caller's cursor.
  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const health = await api.health()
        setCallWindow(health.callWindow)
      } catch {
        /* transient */
      }
    }, 60000)
    return () => window.clearInterval(timer)
  }, [])

  const advance = useCallback(() => {
    const index = leads.findIndex((l) => l.id === activeId)
    const next = leads[index + 1] ?? leads[0] ?? null
    setActiveId(next?.id ?? null)
    device.reset()
    showScript()
  }, [leads, activeId, device, showScript])

  async function handleDisposition(disposition: Disposition, note: string, callbackAt?: string, label?: string) {
    if (!activeLead) return
    setBusy(true)
    try {
      await api.disposition(activeLead.id, {
        disposition,
        dispositionLabel: label,
        note: note || undefined,
        callbackAt,
        callSid: device.callSid ?? undefined,
      })
      const remaining = leads.filter((l) => l.id !== activeLead.id)
      const index = leads.findIndex((l) => l.id === activeLead.id)
      setLeads(remaining)
      setTotal((t) => Math.max(0, t - 1))
      setActiveId(remaining[index]?.id ?? remaining[0]?.id ?? null)
      device.reset()
      showScript()
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveNote(leadId: string, note: string) {
    try {
      const { lead } = await api.updateLead(leadId, { note })
      setLeads((current) => current.map((l) => (l.id === lead.id ? lead : l)))
    } catch (err) {
      setLoadError(`Note not saved: ${(err as Error).message}`)
      throw err
    }
  }

  async function handleArchive() {
    if (!activeLead) return
    setBusy(true)
    try {
      await api.archiveLead(activeLead.id, 'archived from dialer')
      const remaining = leads.filter((l) => l.id !== activeLead.id)
      const index = leads.findIndex((l) => l.id === activeLead.id)
      setLeads(remaining)
      setTotal((t) => Math.max(0, t - 1))
      setActiveId(remaining[index]?.id ?? remaining[0]?.id ?? null)
      device.reset()
      showScript()
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const windowClosed = callWindow ? !callWindow.open : false
  const onInboundCall = device.inbound !== null
  const canDial = Boolean(activeLead) && !windowClosed && !onInboundCall
  const blockedReason = onInboundCall
    ? 'Finish the inbound call first'
    : windowClosed
      ? (callWindow?.reason ?? 'Outside calling hours')
      : null

  const dial = () => {
    if (activeLead) void device.dial(activeLead.phone, { record: activeLead.recordingAllowed && canTranscribeHere })
  }

  return (
    <>
      {callWindow && (
        <div className={`banner ${callWindow.open ? 'open' : 'closed'}`}>
          <strong>{callWindow.open ? 'Calling window open' : 'Calling window closed'}</strong>
          <span>{callWindow.reason}</span>
        </div>
      )}

      <IncomingCallBanner
        enabled={device.incomingEnabled}
        busy={device.incomingBusy}
        inbound={device.inbound}
        seconds={device.inboundSeconds}
        muted={device.muted}
        leads={leads}
        onEnable={() => void device.enableIncoming()}
        onDisable={() => void device.disableIncoming()}
        onAccept={device.acceptInbound}
        onReject={device.rejectInbound}
        onHangup={device.hangupInbound}
        onToggleMute={device.toggleMute}
      />

      {loadError && (
        <div className="banner closed">
          <strong>Error</strong>
          <span>{loadError}</span>
        </div>
      )}

      {narrow && (
        <nav className="dial-switcher">
          {MOBILE_VIEWS.map((view) => (
            <button
              key={view.id}
              className={mobileView === view.id ? 'primary' : ''}
              onClick={() => setMobileView(view.id)}
            >
              {view.id === 'queue' ? `Queue · ${total.toLocaleString()}` : view.label}
            </button>
          ))}
        </nav>
      )}

      <div
        className="dialer"
        ref={dialerRef}
        data-view={narrow ? mobileView : undefined}
        style={{ ['--sidebar-width' as string]: `${sidebar.width}px` }}
      >
        <Queue
          leads={leads}
          total={total}
          activeId={activeId}
          onSelect={(lead) => {
            setActiveId(lead.id)
            device.reset()
            showScript()
          }}
          filters={filters}
          facets={facets}
          onFiltersChange={setFilters}
          offset={offset}
        />

        <div
          className={`col-resizer${sidebar.dragging ? ' dragging' : ''}`}
          onMouseDown={sidebar.startDrag}
          onDoubleClick={sidebar.reset}
          title="Drag to resize · double-click to reset"
        />

        {activeLead ? (
          <div className="pane-stack">
            <ScriptPanel
              lead={activeLead}
              callerName={callerName}
              companyName={companyName}
              callbackNumber={callbackNumber}
              calledUs={history.some((c) => c.direction === 'inbound')}
            />
            <LeadCard
              lead={activeLead}
              leadTimeZone={callWindow?.leadTimeZone ?? 'America/New_York'}
              calls={history}
            />
          </div>
        ) : (
          <div className="pane empty-pane">
            <div className="notice">No lead selected.</div>
          </div>
        )}

        <CallPanel
          lead={activeLead}
          phase={device.phase}
          talkSeconds={device.talkSeconds}
          muted={device.muted}
          error={device.error}
          lastDialStatus={device.lastDialStatus}
          canDial={canDial}
          blockedReason={blockedReason}
          onDial={dial}
          onHangup={device.hangup}
          onToggleMute={device.toggleMute}
          onDisposition={handleDisposition}
          onSaveNote={saveNote}
          onSkip={advance}
          onArchive={() => void handleArchive()}
          busy={busy}
          recording={device.recording}
          transcribing={device.transcribing}
          transcriptProblem={device.transcriptProblem}
          liveWarning={device.liveWarning}
          queuedTranscripts={device.queuedTranscripts}
          recordingAllowed={activeLead?.recordingAllowed ?? false}
          micLabel={micLabel}
        />
      </div>

      {narrow && (
        <MobileCallBar
          lead={activeLead}
          phase={device.phase}
          talkSeconds={device.talkSeconds}
          muted={device.muted}
          canDial={canDial && device.phase === 'idle'}
          busy={busy}
          blockedReason={blockedReason}
          liveWarning={device.liveWarning}
          onDial={dial}
          onHangup={device.hangup}
          onToggleMute={device.toggleMute}
          onPickOutcome={() => setMobileView('call')}
        />
      )}
    </>
  )
}
