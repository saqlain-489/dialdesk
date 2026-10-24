import { useState } from 'react'
import { TRANSCRIPT_STAGE_TEXT } from '../hooks/useTwilioDevice'
import { recordMicrophone, TranscriptError } from '../lib/callRecorder'
import { analyzeMic, MIC_PROBLEM_TEXT, type MicCheck } from '../lib/micCheck'
import { canTranscribeHere } from '../lib/platform'
import { transcribeRecording, type TranscriptionStage } from '../lib/transcription'
import { MicStatus } from './MicStatus'

const SECONDS = 10

type Result = { text: string; seconds: number }

function humVsVoice(check: MicCheck): string {
  const diff = Math.round(check.humDb - check.voiceDb)
  return diff < 0 ? `${-diff} dB under your voice` : `${diff} dB over your voice`
}

export function TranscriptTestPanel() {
  const [countdown, setCountdown] = useState<number | null>(null)
  const [stage, setStage] = useState<TranscriptionStage | null>(null)
  const [working, setWorking] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [check, setCheck] = useState<MicCheck | null>(null)
  const [micLabel, setMicLabel] = useState<string | null>(null)

  async function run() {
    setWorking(true)
    setResult(null)
    setError(null)
    setCheck(null)
    try {
      const recording = await recordMicrophone(SECONDS, setCountdown)
      setCountdown(null)
      setCheck(analyzeMic(recording.pcm, recording.sampleRate))
      setMicLabel(recording.label || null)
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return URL.createObjectURL(recording.blob)
      })
      if (!canTranscribeHere) return
      const out = await transcribeRecording(
        { sid: `setup-test-${Date.now()}`, blob: recording.blob, createdAt: Date.now() },
        setStage,
      )
      setResult({
        text: out.lines.map((l) => l.text).join(' '),
        seconds: out.processingSeconds,
      })
    } catch (err) {
      const stageName = err instanceof TranscriptError ? err.stage : null
      const friendly = stageName ? TRANSCRIPT_STAGE_TEXT[stageName] : null
      setError(`${friendly ?? 'The transcript test failed.'} (${(err as Error).message})`)
    } finally {
      setCountdown(null)
      setStage(null)
      setWorking(false)
    }
  }

  return (
    <div className="card-section">
      <h4>{canTranscribeHere ? 'Mic check + transcript test' : 'Mic check'}</h4>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Records your microphone for {SECONDS} seconds and checks it for electrical hum, background noise and
        distortion. Run it before every shift with the headset on, and say your opener out loud at call
        volume.{' '}
        {canTranscribeHere
          ? 'It then runs the same transcriber real calls use; the first run downloads the model (~75 MB).'
          : 'Transcripts only run on a laptop: a phone browser closes the page when it runs the transcriber.'}
      </p>
      <button onClick={run} disabled={working}>
        {countdown !== null
          ? `Recording… speak now (${countdown}s)`
          : working
            ? 'Transcribing…'
            : canTranscribeHere
              ? 'Test transcript'
              : 'Check mic'}
      </button>

      {stage && (
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          {stage.stage}
          {stage.pct !== null ? ` ${stage.pct}%` : ''}
        </div>
      )}

      {error && (
        <div className="error-box" style={{ marginTop: 10 }}>
          {error}
        </div>
      )}

      {check && (
        <div style={{ marginTop: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <MicStatus label={micLabel} />
          </div>
          <span className={`badge ${check.problems.length ? 'red' : 'green'}`}>
            {check.problems.length ? 'Fix your mic before calling' : 'Mic is good for calls'}
          </span>
          {check.problems.map((problem) => (
            <div key={problem} className="error-box" style={{ marginTop: 8 }}>
              {MIC_PROBLEM_TEXT[problem]}
            </div>
          ))}
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Voice above noise</dt>
            <dd className="mono">{Math.round(check.snrDb)} dB (18+ is fine)</dd>
            <dt>Electrical hum</dt>
            <dd className="mono">{humVsVoice(check)}</dd>
            <dt>Voice level</dt>
            <dd className="mono">{Math.round(check.voiceDb)} dBFS</dd>
            <dt>Distortion</dt>
            <dd className="mono">{check.clippedPct.toFixed(3)}% clipped</dd>
          </dl>
        </div>
      )}

      {audioUrl && !working && (
        <div style={{ marginTop: 10 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
            What it recorded — play it back to check your mic:
          </div>
          <audio controls src={audioUrl} style={{ width: '100%' }} />
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12 }}>
          <span className="badge green">Transcripts work on this computer</span>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Heard</dt>
            <dd>{result.text}</dd>
            <dt>Took</dt>
            <dd className="mono">{result.seconds}s</dd>
          </dl>
        </div>
      )}
    </div>
  )
}
