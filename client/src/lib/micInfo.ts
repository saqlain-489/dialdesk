import { isPhoneOrTablet } from './platform'

// Chrome names its virtual entries "Default - <device>" / "Communications - <device>"; the call's track carries the bare name.
export function micName(label: string): string {
  return label.replace(/^(Default|Communications) - /, '').trim()
}

// "Built-in Audio Analog Stereo" (Linux) is the whole sound card, headset jack included, so it is deliberately not matched.
const BUILT_IN_MIC = /microphone array|\b(built-?in|internal|integrated) (microphone|mic)\b|macbook.*microphone|imac.*microphone|webcam|camera/i

// A laptop's or webcam's own mic sits half a metre from the mouth; leads hear it as "I can't hear you".
export function isBuiltInMic(label: string): boolean {
  return !isPhoneOrTablet && BUILT_IN_MIC.test(label)
}
