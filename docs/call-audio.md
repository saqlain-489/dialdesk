# Call audio: measuring what the other side hears

Early calls had a recurring complaint from the person on the other end: "I can hardly hear you",
"say that again", "I can't understand you". The Voice SDK's own stats looked healthy on most of
those calls. This note records how the cause was found, what the app measures because of it, and
the tools used. Labels: **measured** (observed with a command or in stored data), **reproduced**
(made to happen on purpose), **inference** (reasoned from measurements).

## What was wrong

**1. Ground-loop hum from a charging laptop.** *(reproduced)* A 3.5 mm headset on a laptop that is
charging picked up 50 Hz mains hum through the combo jack. At call gain the hum measured
−14.5 dBFS on the charger and −42.7 dBFS on battery, a 28 dB drop. On the charger the hum was
louder than the voice. Nothing on the caller's side sounds wrong, because the caller never hears
their own mic.

**2. A cable mic far from the mouth.** *(reproduced)* With the laptop on battery and the in-line
mic held close, the phone-band (300 to 3400 Hz) signal-to-noise ratio went from about 14 dB to about
24 dB. Running the scripted opener through the app's own Whisper model after a phone-line
simulation (band-pass, 8 kHz G.711 μ-law), the word error rate fell from **31% to 6%**.

**3. Chrome's auto-gain moving the OS mic volume.** *(reproduced)* Opening the mic with default
constraints raised the system input volume from 0.27 to 0.72 (about +25 dB) within a second, and
the input then clipped. Clipping is what makes auto-gain pull the volume back down, so the level
swung during calls. *(inference for the swing, reproduced for the jump)*

**4. Wi-Fi bufferbloat.** *(reproduced)* Under upload load the Wi-Fi hop to the router went to an
average of 228 ms (max 530 ms) with 1.3% loss, and Twilio's Ashburn edge from 224 ms to 451 ms
with 2.7% loss. Almost all of the added delay sat on the Wi-Fi hop, not the ISP or the ocean.
These were the "barely hear you" calls; the "can't understand you" calls had clean networks.

**5. PCMU has no error correction.** *(configuration measured)* The SDK offers PCMU before Opus.
Opus carries in-band forward error correction, so a dropped packet on a lossy uplink costs less.

## What the SDK numbers actually describe

Reading the Voice SDK source settled what the stored per-call numbers meant:

- `packetsLost`, `jitter` and MOS come from `inbound-rtp`: they describe **the lead's audio
  reaching us**. Nothing in the SDK's samples measured our own voice going out.
- The browser does receive Twilio's RTCP reports about our stream (`remote-inbound-rtp`), but the
  SDK keeps its peer connection private and drops those fields.
- The SDK's mic level is a frequency-bin average rescaled to 0 to 32767 and averaged over listening
  time too. It proves the mic is not dead; it says nothing about clarity.
- Warnings fire from five seconds after the call object exists, so they include ringing.

## What the app does now

| Change | Where |
|---|---|
| Opus first, PCMU as fallback | `client/src/hooks/useTwilioDevice.ts` (`CODECS`) |
| Chrome auto-gain off on every call; the input level is set once in the OS | `useTwilioDevice.ts` (`CALL_MIC`) |
| Our voice's loss and jitter from `remote-inbound-rtp`, via a subclassed `RTCPeerConnection` passed through the SDK's documented option | `client/src/lib/callStats.ts` |
| A live banner when the lead is losing our voice (≥ 5% outbound loss, cleared under 2%) | `useTwilioDevice.ts` |
| Our voice as sent, in dBFS, one value per talk second from `media-source` energy (p90 talking, p10 gaps, peak for clipping); muted seconds skipped | `callStats.ts`, `useTwilioDevice.ts` |
| Warning events stored with `at` = seconds from the answer, negative while ringing | `useTwilioDevice.ts`, `server/src/routes/calls.ts` |
| The mic Chrome is using is named on the Dial page, with a warning for a laptop or webcam mic | `client/src/lib/micInfo.ts`, `hooks/useMicName.ts` |
| The Setup page's mic check: hum (Goertzel at 49 to 51 and 59 to 61 Hz), phone-band SNR (biquad band-pass), level and clipping on the raw mic, through an AudioWorklet tap | `client/src/lib/micCheck.ts`, `lib/callRecorder.ts` |
| Signalling pinned to the Ashburn edge, so a caller far from the US does not hop through the nearest edge first | `useTwilioDevice.ts` (`EDGES`) |

The mic check thresholds come from the measurements above: hum is flagged when it comes within
12 dB of the voice and sits more than 10 dB above the noise floor, and a voice less than 18 dB
above the noise is "weak".

## Tools

The shell scripts in `docs/audio-tools/` were used for the measurements (Linux, PipeWire):

- `mic-test.sh` records silence, the opener at normal pace and slowly, and prints broadband and
  phone-band levels.
- `hum-test.sh` measures 50 Hz hum against phone-band noise; run it on the charger, then on battery.
- `load-test.sh` pings the router at a call's packet rate and the Ashburn edge, idle and under load.
- `vol-log.sh` logs every change of the OS mic volume; with auto-gain off it should never move.
