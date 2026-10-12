import { describe, expect, it } from 'vitest'
import { resolveSelfHostedTranscriptionUrl } from './self-hosted-transcription-url'

describe('resolveSelfHostedTranscriptionUrl', () => {
  it.each([
    ['http://asr-host:8002', 'http://asr-host:8002/v1/audio/transcriptions'],
    ['http://asr-host:8002/', 'http://asr-host:8002/v1/audio/transcriptions'],
    ['  http://100.64.0.10:8002  ', 'http://100.64.0.10:8002/v1/audio/transcriptions'],
    ['http://asr-host:8002/v1', 'http://asr-host:8002/v1/audio/transcriptions'],
    ['http://asr-host:8002/v1/', 'http://asr-host:8002/v1/audio/transcriptions'],
    [
      'http://asr-host:8002/v1/audio/transcriptions',
      'http://asr-host:8002/v1/audio/transcriptions'
    ],
    ['https://asr.example.com/proxy', 'https://asr.example.com/proxy/v1/audio/transcriptions']
  ])('resolves %s', (input, expected) => {
    expect(resolveSelfHostedTranscriptionUrl(input)).toBe(expected)
  })

  it.each(['', '   ', 'asr-host:8002', 'ftp://asr-host/v1', 'not a url'])('rejects %j', (input) => {
    expect(resolveSelfHostedTranscriptionUrl(input)).toBeNull()
  })
})
