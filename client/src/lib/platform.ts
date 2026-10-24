const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent

// iPadOS reports itself as a Mac, so touch support is the tell there.
export const isPhoneOrTablet =
  /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)

// Whisper needs hundreds of MB in the tab; iOS Safari kills the page mid-transcript and reloads it.
export const canTranscribeHere = !isPhoneOrTablet

// Keep in sync with the `max-width: 820px` media queries in styles.css.
export const NARROW_QUERY = '(max-width: 820px)'
