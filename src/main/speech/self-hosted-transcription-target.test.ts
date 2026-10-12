import { describe, expect, it } from 'vitest'
import { getDefaultVoiceSettings } from '../../shared/constants'
import {
  resolveSelfHostedTranscriptionTarget,
  SELF_HOSTED_TRANSCRIPTION_TIMEOUT_MS
} from './self-hosted-transcription-target'

describe('resolveSelfHostedTranscriptionTarget', () => {
  it('builds the endpoint, model and timeout from voice settings', () => {
    expect(
      resolveSelfHostedTranscriptionTarget({
        ...getDefaultVoiceSettings(),
        selfHostedSpeechUrl: 'http://asr-host:8002'
      })
    ).toEqual({
      kind: 'self-hosted',
      url: 'http://asr-host:8002/v1/audio/transcriptions',
      model: 'Qwen/Qwen3-ASR-1.7B',
      apiKey: null,
      timeoutMs: SELF_HOSTED_TRANSCRIPTION_TIMEOUT_MS
    })
  })

  it('omits the model when the setting is blank', () => {
    const target = resolveSelfHostedTranscriptionTarget({
      ...getDefaultVoiceSettings(),
      selfHostedSpeechUrl: 'http://asr-host:8002',
      selfHostedSpeechModel: '  '
    })
    expect(target.model).toBeNull()
  })

  it('rejects a missing server URL, including settings saved before the field existed', () => {
    expect(() => resolveSelfHostedTranscriptionTarget(getDefaultVoiceSettings())).toThrow(
      'Self-hosted transcription server URL is not configured'
    )
    expect(() => resolveSelfHostedTranscriptionTarget(undefined)).toThrow(
      'Self-hosted transcription server URL is not configured'
    )
  })

  it('rejects a URL that is not http(s)', () => {
    expect(() =>
      resolveSelfHostedTranscriptionTarget({
        ...getDefaultVoiceSettings(),
        selfHostedSpeechUrl: 'asr-host:8002'
      })
    ).toThrow('not a valid http(s) URL')
  })
})
