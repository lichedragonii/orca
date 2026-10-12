const TRANSCRIPTIONS_PATH = '/audio/transcriptions'

/**
 * Turns a user-entered server address into the OpenAI-compatible transcription endpoint.
 * Accepts a bare origin (`http://host:8002`), a `/v1` base, or the full endpoint.
 * Returns null for anything that is not an http(s) URL.
 */
export function resolveSelfHostedTranscriptionUrl(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  if (path.endsWith(TRANSCRIPTIONS_PATH)) {
    parsed.pathname = path
  } else if (path.endsWith('/v1')) {
    parsed.pathname = `${path}${TRANSCRIPTIONS_PATH}`
  } else {
    parsed.pathname = `${path}/v1${TRANSCRIPTIONS_PATH}`
  }
  return parsed.toString()
}
