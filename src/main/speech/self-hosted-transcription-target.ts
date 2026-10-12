import type { VoiceSettings } from '../../shared/speech-types'
import { resolveSelfHostedTranscriptionUrl } from '../../shared/self-hosted-transcription-url'
import type { TranscriptionTarget } from './openai-transcription-client'

// Why: a home server behind Tailscale can drop off the network; fail the dictation instead of hanging.
export const SELF_HOSTED_TRANSCRIPTION_TIMEOUT_MS = 60_000

export function resolveSelfHostedTranscriptionTarget(
  voice: VoiceSettings | undefined
): TranscriptionTarget {
  const configured = voice?.selfHostedSpeechUrl?.trim() ?? ''
  if (!configured) {
    throw new Error('Self-hosted transcription server URL is not configured')
  }
  const url = resolveSelfHostedTranscriptionUrl(configured)
  if (!url) {
    throw new Error(
      `Self-hosted transcription server URL is not a valid http(s) URL: ${configured}`
    )
  }
  return {
    kind: 'self-hosted',
    url,
    model: voice?.selfHostedSpeechModel?.trim() || null,
    apiKey: null,
    timeoutMs: SELF_HOSTED_TRANSCRIPTION_TIMEOUT_MS
  }
}
