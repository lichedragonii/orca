import { expect, it, vi } from 'vitest'
import { fixture } from './profile-state-delayed-authority-fixture'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { commitPtyIpcSpawn } from '../../ipc/pty/ipc/spawn-commit'
import { createPtyIpcSpawnState } from '../../ipc/pty/ipc/spawn-state'
import type { PtySpawnIpcDeps } from '../../ipc/pty/ipc/spawn-types'
import { registerPersistedPtySpawn } from '../../ipc/pty/pane/spawn-registration'
import { clearProviderPtyState } from '../../ipc/pty/provider/state-cleanup'
import { ptyOwnership, ptyIncarnationById } from '../../ipc/pty/provider/ownership-state'
import { ptySizes } from '../../ipc/pty/delivery/visibility-state'
import {
  paneSpawnReservationsByOwnerKey,
  reservePaneSpawn,
  reserveIdlePaneSpawn,
  resolvePaneSpawnReservation
} from '../../ipc/pty/pane/spawn-reservation'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

// The runtime controller binds through the layout holder after its spawn returns, not here. Until
// 6g deletes window binds, a stable owner's fenced bind that lands after the exit is not refused.
it('retires an exited ipc binding after disk finishes', async () => {
  const connectionId = null
  const { store, authority, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  const binding = {
    worktreeId: 'repo-local::/fixture/local',
    tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ptyId: 'pty-exited-during-durable-bind',
    incarnationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  }
  runtime.onPtySpawned(binding.ptyId, binding.incarnationId)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  runtime.assertPtyRegistrationAllowed(binding.ptyId, binding.incarnationId)
  const reservationKey = JSON.stringify([connectionId, binding.worktreeId, binding.leafId])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only commit runs; its runtime/store are real and preflight-only dependencies are unreachable.
  const deps = { runtime, store } as PtySpawnIpcDeps
  const ctx = createPtyIpcSpawnState(deps, { ...binding, connectionId, cols: 80, rows: 24 })
  ctx.result = { id: binding.ptyId, incarnationId: binding.incarnationId }
  ctx.metadataLeafId = binding.leafId
  ctx.validatedLeafId = binding.leafId
  const reservation = reservePaneSpawn(reservationKey)
  ctx.paneSpawnReservationKey = reservationKey
  ctx.paneSpawnReservation = reservation
  const gate = authority.pause()
  const pending = expect(commitPtyIpcSpawn(ctx)).resolves.toMatchObject({
    id: binding.ptyId,
    incarnationId: binding.incarnationId
  })
  await gate.started.promise
  const nextReservation = reserveIdlePaneSpawn(reservationKey)
  clearProviderPtyState(binding.ptyId)
  ptyOwnership.delete(binding.ptyId)
  await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
  gate.finish.resolve()
  await pending
  expect(ptyOwnership.has(binding.ptyId)).toBe(false)
  expect(ptyIncarnationById.has(binding.ptyId)).toBe(false)
  expect(ptySizes.has(binding.ptyId)).toBe(false)
  await expect(reservation.promise).resolves.toMatchObject({ id: binding.ptyId })
  const next = await nextReservation
  expect(next).not.toBe(reservation)
  resolvePaneSpawnReservation(reservationKey, next, { id: 'next-spawn' })
  expect(paneSpawnReservationsByOwnerKey.has(reservationKey)).toBe(false)
  const session = readState().workspaceSession
  expect(
    session.terminalLayoutsByTabId[binding.tabId]?.ptyIdsByLeafId?.[binding.leafId]
  ).toBeUndefined()
})

const binding = {
  worktreeId: 'repo-local::/fixture/local',
  tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ptyId: 'exited-pty',
  incarnationId: 'old-incarnation'
}

it.each(['replacement-pty', binding.ptyId])(
  'preserves a replacement binding to %s while retirement waits',
  async (ptyId) => {
    const { store, authority, readState } = await fixture()
    const runtime = new OrcaRuntimeService(store)
    runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
    await store.persistPtyBinding(binding)
    await runtime.onPtyExit(binding.ptyId, 0, binding.incarnationId, { providerExitObserved: true })
    const gate = authority.pause()
    const replacement = store.persistPtyBinding({
      ...binding,
      ptyId,
      incarnationId: 'new-incarnation'
    })
    await gate.started.promise
    const registration = expect(
      registerPersistedPtySpawn(runtime, binding.ptyId, binding.worktreeId, null, binding)
    ).rejects.toThrow('agent_session_exited_during_start')
    gate.finish.resolve()
    await Promise.all([replacement, registration])
    const session = readState().workspaceSession
    expect(session.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[binding.leafId]).toBe(ptyId)
    expect(session.terminalPtyIncarnationsByPaneKey[`${binding.tabId}:${binding.leafId}`]).toBe(
      'new-incarnation'
    )
  }
)

it('retains the binding when loss of contact supplies no process-exit proof', async () => {
  const { store, readState } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  runtime.beginPtyRegistration(binding.ptyId, binding.incarnationId)
  await store.persistPtyBinding(binding)
  await runtime.onPtyExit(binding.ptyId, -1, binding.incarnationId)
  expect(() =>
    registerPersistedPtySpawn(runtime, binding.ptyId, binding.worktreeId, null, binding)
  ).toThrow('agent_session_exited_during_start')
  expect(
    readState().workspaceSession.terminalLayoutsByTabId[binding.tabId].ptyIdsByLeafId[
      binding.leafId
    ]
  ).toBe(binding.ptyId)
})

it('keeps successful registration synchronous through the remaining spawn publication', async () => {
  const { store } = await fixture()
  const runtime = new OrcaRuntimeService(store)
  await store.persistPtyBinding(binding)
  expect(
    registerPersistedPtySpawn(runtime, binding.ptyId, binding.worktreeId, null, binding)
  ).toBeUndefined()
})
