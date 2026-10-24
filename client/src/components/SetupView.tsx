import { useEffect, useState } from 'react'
import { api } from '../api'
import type { OrgSetup } from '../types'
import { useDevice } from '../hooks/useDevice'
import { PreflightPanel } from './PreflightPanel'
import { TranscriberCheckPanel } from './TranscriberCheckPanel'
import { TranscriptTestPanel } from './TranscriptTestPanel'
import { friendlyError } from '../lib/callErrors'
import { canTranscribeHere, isPhoneOrTablet } from '../lib/platform'

export function SetupView() {
  const { runPreflight } = useDevice()
  const [setup, setSetup] = useState<OrgSetup | null>(null)
  const [micState, setMicState] = useState<string>('unknown')

  useEffect(() => {
    api
      .orgSetup()
      .then(setSetup)
      .catch(() => setSetup(null))

    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        setMicState(status.state)
        status.onchange = () => setMicState(status.state)
      })
      .catch(() => setMicState('unknown'))
  }, [])

  async function requestMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      setMicState('granted')
    } catch (err) {
      setMicState(`denied — ${friendlyError(err).action}`)
    }
  }

  return (
    <div className="admin" style={{ maxWidth: 720 }}>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Before you start calling</h2>

      <div className="card-section">
        <h4>Checklist</h4>
        <dl className="kv">
          <dt>Twilio</dt>
          <dd>
            {setup?.twilioConfigured ? (
              <span className="badge green">configured · calls from {setup.callerId}</span>
            ) : (
              <span className="badge red">not configured — dialing disabled</span>
            )}
          </dd>
          {setup?.voiceWebhookUrl && (
            <>
              <dt>TwiML App Voice URL</dt>
              <dd>
                <code style={{ wordBreak: 'break-all' }}>{setup.voiceWebhookUrl}</code>
                <div className="muted" style={{ fontSize: 12 }}>
                  Paste this exact string into this workspace's TwiML App in Twilio (POST).
                </div>
              </dd>
            </>
          )}
          <dt>Microphone</dt>
          <dd>
            <span className={`badge ${micState === 'granted' ? 'green' : 'yellow'}`}>{micState}</span>
            {micState !== 'granted' && (
              <button onClick={requestMic} style={{ marginLeft: 8 }}>
                Grant access
              </button>
            )}
          </dd>
          <dt>Calling window</dt>
          <dd>
            {setup && (
              <span className={`badge ${setup.callWindow.open ? 'green' : 'red'}`}>
                {setup.callWindow.reason}
              </span>
            )}
          </dd>
          <dt>Headset</dt>
          <dd className="muted">
            {isPhoneOrTablet
              ? 'Use earphones with a mic, not the speakerphone (it echoes back to them). Keep this page open with the screen on during a call: if the phone locks or you switch apps, they stop hearing you.'
              : 'Use a wired headset. Laptop speakers cause echo that the person on the other end hears.'}
          </dd>
        </dl>
      </div>

      <PreflightPanel runPreflight={runPreflight} />
      <TranscriptTestPanel />
      {canTranscribeHere && <TranscriberCheckPanel />}
    </div>
  )
}
