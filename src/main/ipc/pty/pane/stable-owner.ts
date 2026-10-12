import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { UNVERIFIED_PROCESS_EXIT_CODE } from '../../../../shared/terminal-exit-cause'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import { getPtySshConnectionId } from '../provider/registry'
import {
  isDaemonEndpointGoneError,
  SessionNotFoundError,
  TerminalHostGoneError,
  TerminalSessionOwnerUnverifiedError
} from '../../../daemon/daemon-errors'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { spawnCommitBindingOrigin } from '../../../persistence/loading-store/pty-binding-span'

export type StablePaneOwner = {
  handle?: string
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  hasPersistedBinding?: true
  persistedIncarnationId?: string
  runtimeIncarnationId?: string
}
export type StablePaneAdoption = {
  result: PtySpawnResult
  owner: StablePaneOwner
  materialized?: true
} | null
export const stablePaneAdoptionsByOwnerKey = new Map<string, Promise<StablePaneAdoption>>()

export function resolvePersistedStablePaneOwner(
  store: Store | undefined,
  paneKey: string,
  worktreeId: string,
  connectionId: string | null | undefined
): Pick<StablePaneOwner, 'tabId' | 'leafId' | 'ptyId' | 'incarnationId'> | null {
  if (!store || typeof store.getWorkspaceSession !== 'function') {
    return null
  }
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  const session = store.getWorkspaceSession(
    connectionId ? toSshExecutionHostId(connectionId) : undefined
  )
  const tab = session.tabsByWorktree?.[worktreeId]?.find(
    (candidate) => candidate.id === parsed.tabId && candidate.worktreeId === worktreeId
  )
  const ptyId = session.terminalLayoutsByTabId?.[parsed.tabId]?.ptyIdsByLeafId?.[parsed.leafId]
  if (!tab || typeof ptyId !== 'string' || ptyId.length === 0) {
    return null
  }
  const incarnationId = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  return {
    tabId: parsed.tabId,
    leafId: parsed.leafId,
    ptyId,
    ...(incarnationId ? { incarnationId } : {})
  }
}

export function resolveStablePaneOwner(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  paneKey: string | null | undefined,
  worktreeId: string | undefined,
  connectionId: string | null | undefined
): StablePaneOwner | null {
  if (!paneKey || !worktreeId) {
    return null
  }
  let resolved: ReturnType<OrcaRuntimeService['resolveTerminalPane']> | null = null
  let resolvedHandleCandidate: ReturnType<OrcaRuntimeService['resolveTerminalPane']> | null = null
  if (runtime && typeof runtime.resolveTerminalPane === 'function') {
    try {
      const candidate = runtime.resolveTerminalPane(paneKey, worktreeId)
      resolvedHandleCandidate = candidate
      resolved = candidate.connected === false ? null : candidate
    } catch (error) {
      if (!(error instanceof Error && error.message === 'terminal_not_found')) {
        throw error
      }
    }
  }
  const persisted = resolvePersistedStablePaneOwner(store, paneKey, worktreeId, connectionId)
  if (resolved?.ptyId && persisted && resolved.ptyId !== persisted.ptyId) {
    throw new Error('terminal_pane_owner_conflict')
  }
  const ptyId = resolved?.ptyId ?? persisted?.ptyId
  if (!ptyId) {
    return null
  }
  if (getPtySshConnectionId(ptyId) !== (connectionId ?? null)) {
    throw new Error('terminal_pane_owner_host_mismatch')
  }
  const runtimeIncarnationId = ptyIncarnationById.get(ptyId)
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  return {
    ...(resolvedHandleCandidate?.ptyId === ptyId ? { handle: resolvedHandleCandidate.handle } : {}),
    tabId: resolved?.tabId || persisted?.tabId || parsed.tabId,
    leafId: resolved?.leafId || persisted?.leafId || parsed.leafId,
    ptyId,
    ...(runtimeIncarnationId || persisted?.incarnationId
      ? { incarnationId: runtimeIncarnationId ?? persisted?.incarnationId }
      : {}),
    ...(persisted ? { hasPersistedBinding: true as const } : {}),
    ...(persisted?.incarnationId ? { persistedIncarnationId: persisted.incarnationId } : {}),
    ...(runtimeIncarnationId ? { runtimeIncarnationId } : {})
  }
}

/** Attach absence: the pane stays, unbound; false when it now shows another terminal. */
export function unbindAbsentStablePaneOwner(
  runtime: OrcaRuntimeService | undefined,
  owner: StablePaneOwner,
  worktreeId: string,
  connectionId: string | null | undefined
): boolean {
  if (!runtime) {
    return true
  }
  const incarnationId = owner.persistedIncarnationId ?? owner.incarnationId
  return (
    runtime.unbindAbsentTerminal({
      worktreeId,
      connectionId,
      tabId: owner.tabId,
      leafId: owner.leafId,
      ptyId: owner.ptyId,
      ...(incarnationId ? { incarnationId } : {})
    }) !== 'replaced'
  )
}

export type StablePaneSpawnContext = {
  runtime: OrcaRuntimeService | undefined
  store?: Store
  provider: IPtyProvider
  spawnOptions: PtySpawnOptions
  owner: StablePaneOwner | null
  worktreeId?: string
  connectionId?: string | null
  resolveOwner?: () => StablePaneOwner | null
  onFreshSpawn?: (result: PtySpawnResult) => void
}

export function stablePanePersistenceFence(
  owner: StablePaneOwner | null
): { ptyId: string; incarnationId?: string } | undefined {
  return owner?.hasPersistedBinding
    ? {
        ptyId: owner.ptyId,
        ...(owner.persistedIncarnationId ? { incarnationId: owner.persistedIncarnationId } : {})
      }
    : undefined
}

export async function persistAdmittedStablePaneBinding(args: {
  store: Store | undefined
  owner: StablePaneOwner | null
  result: PtySpawnResult
  worktreeId: string | undefined
  startupCwd: string | undefined
}): Promise<boolean> {
  const expectedBinding = stablePanePersistenceFence(args.owner)
  if (!args.store || !args.owner || !args.worktreeId || !expectedBinding) {
    return false
  }
  const persisted = await args.store.persistPtyBinding({
    worktreeId: args.worktreeId,
    tabId: args.owner.tabId,
    leafId: args.owner.leafId,
    ptyId: args.result.id,
    ...(args.result.incarnationId ? { incarnationId: args.result.incarnationId } : {}),
    ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
    expectedBinding,
    origin: spawnCommitBindingOrigin(args.result)
  })
  if (persisted === false) {
    throw new Error('terminal_pane_owner_changed')
  }
  return true
}

export async function attachStablePaneOwner(
  args: StablePaneSpawnContext & { owner: StablePaneOwner }
): Promise<{ result: PtySpawnResult; owner: StablePaneOwner } | null> {
  const { owner, provider, runtime, spawnOptions } = args
  let result: PtySpawnResult
  try {
    result = await provider.spawn({
      ...spawnOptions,
      sessionId: owner.ptyId,
      attachOnly: true,
      expectedIncarnationId: owner.runtimeIncarnationId ?? owner.persistedIncarnationId,
      expectedIncarnationIsAuthoritative: owner.runtimeIncarnationId !== undefined,
      isNewSession: undefined,
      command: undefined,
      commandDelivery: undefined,
      startupCommandDelivery: undefined,
      launchAgent: undefined,
      startupIngress: undefined,
      agentSessionEnsure: undefined,
      agentSessionCreateOperationId: undefined,
      onPtySpawnCommitted: undefined
    })
  } catch (error) {
    if (error instanceof TerminalSessionOwnerUnverifiedError) {
      throw new Error('terminal_pane_owner_unverified')
    }
    // Why: translate before paired-runtime RPC strips the socket error's code and syscall.
    if (isDaemonEndpointGoneError(error)) {
      throw new TerminalHostGoneError()
    }
    // Why: only the process that owns the PTY answers this, so its absence is an observed exit.
    if (!(error instanceof SessionNotFoundError)) {
      throw error
    }
    const ownerBeforeRetire = args.resolveOwner?.()
    if (
      ownerBeforeRetire &&
      (ownerBeforeRetire.ptyId !== owner.ptyId ||
        ownerBeforeRetire.runtimeIncarnationId !== owner.runtimeIncarnationId ||
        ownerBeforeRetire.hasPersistedBinding !== owner.hasPersistedBinding ||
        ownerBeforeRetire.persistedIncarnationId !== owner.persistedIncarnationId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    runtime?.onPtyExit(owner.ptyId, UNVERIFIED_PROCESS_EXIT_CODE, owner.incarnationId, {
      hostExitConfirmed: true
    })
    clearProviderPtyState(owner.ptyId)
    ptyOwnership.delete(owner.ptyId)
    if (
      args.worktreeId &&
      !unbindAbsentStablePaneOwner(runtime, owner, args.worktreeId, args.connectionId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    if (args.resolveOwner?.()) {
      throw new Error('terminal_pane_owner_changed')
    }
    return null
  }
  if (
    result.id !== owner.ptyId ||
    result.isReattach !== true ||
    (owner.runtimeIncarnationId !== undefined &&
      result.incarnationId !== owner.runtimeIncarnationId) ||
    (result.incarnationId === undefined && owner.incarnationId !== undefined)
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  return { result, owner }
}

export async function spawnForStablePane(
  args: StablePaneSpawnContext
): Promise<{ result: PtySpawnResult; owner: StablePaneOwner | null }> {
  if (args.owner) {
    const attached = await attachStablePaneOwner({ ...args, owner: args.owner })
    if (attached) {
      return attached
    }
  }
  const result = await args.provider.spawn(args.spawnOptions)
  args.onFreshSpawn?.(result)
  return { result, owner: null }
}
