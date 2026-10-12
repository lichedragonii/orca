import { resampleToRate } from './stt-audio-resample'

export const OPENAI_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'openai-gpt-4o-mini-transcribe': 'gpt-4o-mini-transcribe',
  'openai-gpt-4o-transcribe': 'gpt-4o-transcribe'
}

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const CLOUD_TRANSCRIPTION_SAMPLE_RATE = 16000
const MAX_CLOUD_AUDIO_SECONDS = 10 * 60
// Qwen3-ASR behind plain vLLM prefixes `language Korean\n` or `language Korean<asr_text>`.
const ASR_LANGUAGE_PREFIX = /^language\s+\S+?[,\s]*(?:\n|<asr_text>)/i

export type TranscriptionTarget = {
  kind: 'openai' | 'self-hosted'
  url: string
  /** null omits the multipart `model` field. */
  model: string | null
  apiKey: string | null
  /** Unset waits as long as fetch does. */
  timeoutMs?: number
}

export function resolveOpenAiTranscriptionTarget(
  modelId: string,
  readApiKey: () => string
): TranscriptionTarget {
  const apiModel = OPENAI_TRANSCRIPTION_MODEL_BY_ID[modelId]
  if (!apiModel) {
    throw new Error(`Unknown OpenAI transcription model: ${modelId}`)
  }
  return {
    kind: 'openai',
    url: OPENAI_TRANSCRIPTION_URL,
    model: apiModel,
    apiKey: readApiKey()
  }
}

export function stripAsrLanguagePrefix(text: string): string {
  return text.replace(ASR_LANGUAGE_PREFIX, '').trim()
}

type OpenAiTranscriptionResponse = {
  text?: unknown
  error?: {
    message?: unknown
  }
}

export function sanitizeOpenAiTranscriptionErrorMessage(message: string): string {
  if (/incorrect api key provided:/i.test(message)) {
    return 'Incorrect OpenAI API key provided.'
  }

  const sanitized = message
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .trim()

  return sanitized || 'OpenAI transcription request failed'
}

function encodePcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    buffer.writeInt16LE(Math.round(value), 44 + i * 2)
  }

  return buffer
}

function combineChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const combined = new Float32Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

function parseOpenAiTranscriptionResponse(
  data: OpenAiTranscriptionResponse,
  target: TranscriptionTarget
): string {
  if (typeof data.text === 'string') {
    return target.kind === 'self-hosted' ? stripAsrLanguagePrefix(data.text) : data.text.trim()
  }
  if (typeof data.error?.message === 'string') {
    throw new Error(sanitizeOpenAiTranscriptionErrorMessage(data.error.message))
  }
  throw new Error(`${transcriptionLabel(target)} transcription response did not include text`)
}

function transcriptionLabel(target: TranscriptionTarget): string {
  return target.kind === 'self-hosted' ? 'Self-hosted' : 'OpenAI'
}

function describeFetchFailure(error: unknown, timeoutMs: number | undefined): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `no response within ${Math.round((timeoutMs ?? 0) / 1000)}s`
  }
  // Node's fetch reports "fetch failed" and keeps the socket error (ECONNREFUSED, ENOTFOUND) in cause.
  const cause = error instanceof Error ? error.cause : undefined
  if (cause instanceof Error) {
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : null
    return code ?? cause.message
  }
  return error instanceof Error ? error.message : String(error)
}

export class OpenAiTranscriptionSession {
  private chunks: Float32Array[] = []
  private audioSeconds = 0

  // Why: resolved at finish so the key (keychain prompt) and server URL are read only when sending.
  constructor(private readonly resolveTarget: () => TranscriptionTarget) {}

  feedAudio(samples: Float32Array, sampleRate: number): void {
    const normalized = resampleToRate(samples, sampleRate, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    this.audioSeconds += normalized.length / CLOUD_TRANSCRIPTION_SAMPLE_RATE
    if (this.audioSeconds > MAX_CLOUD_AUDIO_SECONDS) {
      throw new Error('Cloud transcription is limited to 10 minutes per dictation')
    }
    this.chunks.push(new Float32Array(normalized))
  }

  async finish(): Promise<string> {
    if (this.chunks.length === 0) {
      return ''
    }

    const target = this.resolveTarget()
    const audio = combineChunks(this.chunks)
    this.chunks = []
    const wav = encodePcm16Wav(audio, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    const form = new FormData()
    if (target.model) {
      form.append('model', target.model)
    }
    form.append('response_format', 'json')
    // Why: OpenAI's transcription endpoint expects a multipart file object;
    // a named WAV blob avoids filesystem temp files and works in packaged apps.
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav')

    let response: Response
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
        body: form,
        signal: target.timeoutMs ? AbortSignal.timeout(target.timeoutMs) : undefined
      })
    } catch (error) {
      if (target.kind !== 'self-hosted') {
        throw error
      }
      throw new Error(
        `Could not reach the self-hosted transcription server at ${target.url} (${describeFetchFailure(error, target.timeoutMs)})`
      )
    }

    const data = (await response.json().catch(() => ({}))) as OpenAiTranscriptionResponse
    if (!response.ok) {
      const message =
        typeof data.error?.message === 'string'
          ? sanitizeOpenAiTranscriptionErrorMessage(data.error.message)
          : response.statusText
      throw new Error(`${transcriptionLabel(target)} transcription failed: ${message}`)
    }

    return parseOpenAiTranscriptionResponse(data, target)
  }
}
