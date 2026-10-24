# In-browser transcription

Every recorded call is transcribed on the caller's own machine. No audio is uploaded or stored
anywhere; only the resulting text is sent to the server and attached to the call.

## How it works

1. **Two legs, two channels.** When the call connects, `client/src/lib/callRecorder.ts` merges the
   caller's mic (left) and the lead's audio from the WebRTC peer connection (right) into one stereo
   recording. Each channel is transcribed on its own, so speaker attribution is exact instead of a
   diarization guess, which matters most when both people talk at once.
2. **After hangup, never during a call.** Whisper at full CPU competes with the live call's audio.
   The job queue runs one job at a time and only while no call is live. A dial pauses a running
   transcription; a side that already finished is kept, so the job resumes instead of restarting.
   The first-time model download is not paused, because restarting it on every dial meant it
   never finished.
3. **A Web Worker on the CPU.** `client/src/workers/transcribe.worker.ts` runs
   `Xenova/whisper-base.en` (q8) through transformers.js on WASM. The model and ONNX runtime are
   fetched once from the Hugging Face CDN and then served from the browser cache.
4. **Waiting recordings survive a closed tab.** Each recording waits in IndexedDB
   (`client/src/lib/pendingTranscripts.ts`), tagged with its workspace, and resumes the next time
   the Dial page opens in that workspace. It is deleted once transcribed or after 48 hours.
5. **Failures are visible.** Every stage that can fail (recorder start, decode, model load,
   silence, garbled output, upload) is reported to the server as `transcriptError` with a stage
   name, and the Transcripts page can list them.
6. **Consent is checked twice.** The browser only records leads whose state is in
   `TRANSCRIBE_STATES`, and the server re-checks the lead's state before it accepts a transcript,
   so a stale tab can't land one for a state that was never allowed.
7. **Not on phones.** Whisper's memory use made iOS Safari kill and reload the tab mid-transcript,
   so phones and tablets never record; their Setup page runs the mic check only.

## The WebGPU word salad

Transcripts from one Windows laptop came back as the same nonsense for every call ("reactive
classes null summoned union…"), took 7 to 38 minutes for a 20-second call, and most never arrived.

**Cause.** The worker used to run Whisper on the GPU whenever the browser offered WebGPU. Chrome
on Windows exposes a WebGPU adapter; Chrome on the Linux machine used for development did not, so
only the Windows laptop took the GPU path. Whisper `base.en` with `q8` weights on WebGPU ignores
its input and emits a fixed word salad at about 15× slower than real time. transformers.js itself
defaults to `q8` for WASM and fp32 for WebGPU; the worker had forced `q8` onto WebGPU.

**Reproduced** in headless Chrome with WebGPU switched on, using transformers.js's own 11-second
test clip:

| Backend and precision | Output | Time for the 11 s clip |
|---|---|---|
| WASM, `q8` (what calls use now) | correct | 7.0 to 8.3 s |
| WebGPU, `q8` (the old path) | the same word salad as the Windows laptop | 159 to 164 s |
| WebGPU, `fp16` | "The The the The The" | 4.4 s |
| WebGPU, fp32 encoder + `q4` decoder | correct | 9.3 s |
| WebGPU, `fp32` | correct | 7.2 s, after a 290 MB download |

The GPU gave nothing over the CPU on that hardware, and half its settings were broken.

**Fix.**

- Transcription runs on WASM only; the GPU path and its fallback logic are gone.
- Output that looks like the salad (both speakers identical, or more than 12% junk tokens) is
  rejected as `garbled` instead of being saved.
- A dial no longer throws away finished work, and the model download keeps going during calls.
- The Setup page's **Transcriber check** runs the same clip through the exact call path on any machine and
  prints PASS or FAIL with timings, plus the browser, core count, memory and WebGPU adapter. It
  can also re-run the old GPU setting to show the failure on that machine.

## Expectations

Phone audio is 8 kHz, upsampled to 16 kHz. Expect transcripts that are good enough to review what
happened on a call and to improve the opener, not good enough to quote word for word.
