// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelfHostedTranscriptionSettingsRow } from './SelfHostedTranscriptionSettingsRow'

let root: Root | null = null

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function renderRow(serverUrl: string): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <SelfHostedTranscriptionSettingsRow
        serverUrl={serverUrl}
        model="Qwen/Qwen3-ASR-1.7B"
        disabled={false}
        onServerUrlChange={vi.fn()}
        onModelChange={vi.fn()}
      />
    )
  })
  return container
}

describe('SelfHostedTranscriptionSettingsRow', () => {
  it('shows the endpoint the server address resolves to', async () => {
    const container = await renderRow('http://asr-host:8002')

    expect(container.textContent).toContain(
      'Requests go to http://asr-host:8002/v1/audio/transcriptions'
    )
    expect(container.querySelector('#self-hosted-speech-url')?.getAttribute('aria-invalid')).toBe(
      'false'
    )
  })

  it('flags an address without an http(s) scheme', async () => {
    const container = await renderRow('asr-host:8002')

    expect(container.textContent).toContain('Enter an http:// or https:// address.')
    expect(container.querySelector('#self-hosted-speech-url')?.getAttribute('aria-invalid')).toBe(
      'true'
    )
  })

  it('asks for an address when none is set', async () => {
    const container = await renderRow('')

    expect(container.textContent).toContain('Required.')
  })
})
