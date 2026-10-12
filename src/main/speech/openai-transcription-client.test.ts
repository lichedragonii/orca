import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OpenAiTranscriptionSession,
  resolveOpenAiTranscriptionTarget,
  sanitizeOpenAiTranscriptionErrorMessage,
  stripAsrLanguagePrefix,
  type TranscriptionTarget
} from './openai-transcription-client'

describe('sanitizeOpenAiTranscriptionErrorMessage', () => {
  it('does not expose the invalid OpenAI API key echoed by the provider', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Incorrect API key provided: fsdfdsfsdf. You can find your API key at https://platform.openai.com/account/api-keys.'
      )
    ).toBe('Incorrect OpenAI API key provided.')
  })

  it('redacts API keys and bearer tokens from other provider errors', () => {
    expect(
      sanitizeOpenAiTranscriptionErrorMessage(
        'Request failed for sk-testSecret123 with Authorization: Bearer token-value_123'
      )
    ).toBe('Request failed for [redacted] with Authorization: Bearer [redacted]')
  })
})

describe('stripAsrLanguagePrefix', () => {
  it.each([
    ['language Korean\n안녕하세요.', '안녕하세요.'],
    ['language Korean<asr_text>안녕하세요.', '안녕하세요.'],
    ['language French,\nBonjour', 'Bonjour'],
    ['안녕하세요.', '안녕하세요.'],
    ['the language English is hard', 'the language English is hard']
  ])('turns %j into %j', (input, expected) => {
    expect(stripAsrLanguagePrefix(input)).toBe(expected)
  })
})

describe('OpenAiTranscriptionSession', () => {
  const selfHosted: TranscriptionTarget = {
    kind: 'self-hosted',
    url: 'http://asr-host:8002/v1/audio/transcriptions',
    model: 'Qwen/Qwen3-ASR-1.7B',
    apiKey: null,
    timeoutMs: 60_000
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
    const fetchMock = vi.fn(impl)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  function formOf(init: RequestInit): FormData {
    if (!(init.body instanceof FormData)) {
      throw new Error('expected a multipart body')
    }
    return init.body
  }

  async function transcribe(target: TranscriptionTarget): Promise<string> {
    const session = new OpenAiTranscriptionSession(() => target)
    session.feedAudio(new Float32Array([0.1, -0.1]), 16000)
    return session.finish()
  }

  it('posts to the self-hosted server without an auth header and strips the language prefix', async () => {
    const fetchMock = stubFetch(async () =>
      Response.json({ text: 'language Korean<asr_text>안녕하세요.' })
    )

    await expect(transcribe(selfHosted)).resolves.toBe('안녕하세요.')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(selfHosted.url)
    expect(init.headers).toEqual({})
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const form = formOf(init)
    expect(form.get('model')).toBe('Qwen/Qwen3-ASR-1.7B')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  it('omits the model field when the self-hosted model is blank', async () => {
    const fetchMock = stubFetch(async () => Response.json({ text: 'ok' }))

    await transcribe({ ...selfHosted, model: null })

    expect(formOf(fetchMock.mock.calls[0][1]).has('model')).toBe(false)
  })

  it('names the socket error when the self-hosted server is unreachable', async () => {
    stubFetch(async () => {
      const cause = Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED'
      })
      throw new TypeError('fetch failed', { cause })
    })

    await expect(transcribe(selfHosted)).rejects.toThrow(
      'Could not reach the self-hosted transcription server at http://asr-host:8002/v1/audio/transcriptions (ECONNREFUSED)'
    )
  })

  it('reports a self-hosted timeout in seconds', async () => {
    stubFetch(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })

    await expect(transcribe(selfHosted)).rejects.toThrow('(no response within 60s)')
  })

  it('labels self-hosted HTTP errors with the server message', async () => {
    stubFetch(async () =>
      Response.json(
        { error: { message: 'The model `qwen3-asr` does not exist.' } },
        { status: 404 }
      )
    )

    await expect(transcribe({ ...selfHosted, model: 'qwen3-asr' })).rejects.toThrow(
      'Self-hosted transcription failed: The model `qwen3-asr` does not exist.'
    )
  })

  it('keeps the OpenAI request authenticated and does not touch its text', async () => {
    const fetchMock = stubFetch(async () => Response.json({ text: ' hello ' }))

    await expect(
      transcribe(resolveOpenAiTranscriptionTarget('openai-gpt-4o-transcribe', () => 'sk-test'))
    ).resolves.toBe('hello')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init.headers).toEqual({ Authorization: 'Bearer sk-test' })
    expect(init.signal).toBeUndefined()
    expect(formOf(init).get('model')).toBe('gpt-4o-transcribe')
  })
})
