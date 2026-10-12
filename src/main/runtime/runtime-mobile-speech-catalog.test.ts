import { describe, expect, it, vi } from 'vitest'

vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: () => ({
    getModelStates: async () => [{ id: 'self-hosted-transcribe', status: 'ready' }]
  }),
  getSpeechSttService: vi.fn()
}))

import { RuntimeMobileSpeechCatalog } from './runtime-mobile-speech-catalog'
import type { RuntimeStore } from './runtime-store-contract'

describe('RuntimeMobileSpeechCatalog', () => {
  it('sends self-hosted models to mobile as the remote provider older clients understand', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: list() reads only getSettings(); the empty settings exercise the voice defaults.
    const store = { getSettings: () => ({}) } as unknown as RuntimeStore
    const setup = await new RuntimeMobileSpeechCatalog(() => store).list()

    const selfHosted = setup.models.find((model) => model.id === 'self-hosted-transcribe')
    expect(selfHosted).toMatchObject({
      provider: 'openai',
      status: 'ready',
      sizeBytes: null
    })
    expect(new Set(setup.models.map((model) => model.provider))).toEqual(
      new Set(['local', 'openai'])
    )
  })
})
