import { isTerminalSessionStorageCapacityFailure } from '../../../shared/terminal-session-state-save-failure'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred, fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { ptyIncarnationById, ptyOwnership } from '../../ipc/pty/provider/ownership-state'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { createPtySpawnCommitDependencies } from './pty-spawn-commit-dependencies-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'replaced-during-save',
  incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
}
const replacementIncarnation = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

afterEach(() => {
  clearProviderPtyState(binding.ptyId)
  ptyOwnership.delete(binding.ptyId)
})

it.each(
  ['save', 'shutdown'].flatMap((replacementDuring) =>
    ['profile-state-writer-exit', 'ENOSPC'].map((code) => ({ replacementDuring, code }))
  )
)(
  'preserves a successor during $replacementDuring when the predecessor ipc save fails with $code',
  async ({ replacementDuring, code }) => {
    const { store, authority } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
    ptyIncarnationById.set(binding.ptyId, binding.incarnationId)
    const deps = createPtySpawnCommitDependencies(runtime, store)
    const shutdownStarted = deferred<void>()
    const shutdownFinished = deferred<void>()
    const holdShutdown = async () => {
      shutdownStarted.resolve()
      await shutdownFinished.promise
    }
    let commit: () => Promise<unknown>
    let shutdown: ReturnType<typeof vi.spyOn>
    const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
    ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
    ctx.metadataLeafId = binding.leafId
    ctx.validatedLeafId = binding.leafId
    shutdown = vi.spyOn(ctx.provider, 'shutdown').mockImplementation(holdShutdown)
    commit = () => commitPtyIpcSpawn(ctx)

    const gate = authority.pause()
    const pending = commit().catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) {
        throw error
      }
      expect(error.message).toContain('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
      expect(isTerminalSessionStorageCapacityFailure(error.message)).toBe(code === 'ENOSPC')
      return 'rejected'
    })
    await gate.started.promise
    if (replacementDuring === 'shutdown') {
      gate.finish.reject(Object.assign(new Error('worker exited'), { code }))
      await shutdownStarted.promise
    }
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    runtime.onPtySpawned(binding.ptyId, replacementIncarnation)
    ptyIncarnationById.set(binding.ptyId, replacementIncarnation)
    ptyOwnership.set(binding.ptyId, 'ssh:successor-host')
    if (replacementDuring === 'save') {
      gate.finish.reject(Object.assign(new Error('worker exited'), { code }))
    }
    shutdownFinished.resolve()
    expect(await pending).toBe('rejected')
    if (replacementDuring === 'save') {
      expect(shutdown).not.toHaveBeenCalled()
    } else {
      expect(shutdown).toHaveBeenCalledExactlyOnceWith(binding.ptyId, {
        immediate: true,
        expectedIncarnationId: binding.incarnationId
      })
    }
    expect(ptyIncarnationById.get(binding.ptyId)).toBe(replacementIncarnation)
    expect(ptyOwnership.get(binding.ptyId)).toBe('ssh:successor-host')
    await runtime.onPtyExit(binding.ptyId, 0, replacementIncarnation, {
      providerExitObserved: true
    })
  }
)

it('keeps replacement provider identity when an exited ipc spawn finishes saving', async () => {
  const { store, authority } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
  let commit: () => Promise<unknown>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; the runtime/store are real and preflight-only dependencies are unreachable.
  const deps = { runtime, store } as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
  ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
  ctx.metadataLeafId = binding.leafId
  ctx.validatedLeafId = binding.leafId
  commit = () => commitPtyIpcSpawn(ctx)

  const gate = authority.pause()
  const pending = expect(commit()).rejects.toThrow('agent_session_exited_during_start')
  await gate.started.promise
  await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
  runtime.onPtySpawned(binding.ptyId, replacementIncarnation)
  runtime.seedHeadlessTerminal(binding.ptyId, 'replacement history', { cols: 112, rows: 37 })
  ptyIncarnationById.set(binding.ptyId, replacementIncarnation)
  gate.finish.resolve()
  await pending
  expect(ptyIncarnationById.get(binding.ptyId)).toBe(replacementIncarnation)
  expect(await runtime.serializeMainTerminalBuffer(binding.ptyId)).toMatchObject({
    cols: 112,
    rows: 37
  })
  await runtime.onPtyExit(binding.ptyId, 0, replacementIncarnation, {
    providerExitObserved: true
  })
})

it('does not label an IPC binding ownership refusal as a storage failure', async () => {
  const { store } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  const deps = createPtySpawnCommitDependencies(runtime, store)
  const ctx = createPtyIpcSpawnState(deps, { ...binding, cols: 80, rows: 24 })
  ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
  ctx.validatedLeafId = binding.leafId
  vi.spyOn(store, 'persistPtyBinding').mockResolvedValue(false)
  await expect(commitPtyIpcSpawn(ctx)).rejects.toThrow('terminal_pane_owner_changed')
})
