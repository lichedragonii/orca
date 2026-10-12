import './orca-runtime-test-lifecycle.spec'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../shared/constants'

function twoPaneSession(): WorkspaceSessionState {
  return makeWorkspaceSessionWithHeadlessTerminal({
    terminalLayoutsByTabId: {
      'host-tab': makeHeadlessTerminalLayout({
        [HEADLESS_LEAF_ID]: 'pty-a',
        [HEADLESS_SECOND_LEAF_ID]: 'pty-b'
      })
    }
  })
}

/** A Store with one partition per host, so the runtime's holder loads and saves real sessions. */
function partitionedStore(sessions: Partial<Record<ExecutionHostId, WorkspaceSessionState>>) {
  const all: Record<string, WorkspaceSessionState> = { local: getDefaultWorkspaceSession() }
  Object.assign(all, sessions)
  return {
    sessions: all,
    getWorkspaceSessionHostIds: () => Object.keys(all),
    getWorkspaceSession: (hostId?: string | null) => all[hostId ?? 'local']!,
    setWorkspaceSession: vi.fn((session: WorkspaceSessionState, hostId?: string | null) => {
      all[hostId ?? 'local'] = session
    })
  }
}

function runtimeOn(store: ReturnType<typeof partitionedStore>): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The holder reads only the session members this store defines.
  return new OrcaRuntimeService(store as never)
}

const statusOf = (layout: PublishedWorkspaceLayout | undefined, leafId: string) =>
  layout?.tabs.flatMap((tab) => tab.terminal?.panes ?? []).find((pane) => pane.leafId === leafId)
    ?.status

describe('the runtime wired to its layout holder', () => {
  // "Reconnect lost every tab" was reverted twice: attach absence must touch only its own pane.
  it.each([
    { hostId: 'local' as const, connectionId: null },
    { hostId: 'ssh:conn-1' as const, connectionId: 'conn-1' }
  ])('unbinds only the absent pane of a two-pane tab on $hostId', ({ hostId, connectionId }) => {
    const store = partitionedStore({ [hostId]: twoPaneSession() })
    const runtime = runtimeOn(store)

    const result = runtime.unbindAbsentTerminal({
      worktreeId: TEST_WORKTREE_ID,
      connectionId,
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      ptyId: 'pty-a'
    })

    expect(result).toBe('kept')
    const saved = store.sessions[hostId]!
    expect(saved.tabsByWorktree[TEST_WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['host-tab'])
    const layout = saved.terminalLayoutsByTabId['host-tab']
    expect(layout?.root).toMatchObject({ type: 'split' })
    expect(layout?.ptyIdsByLeafId).toEqual({ [HEADLESS_SECOND_LEAF_ID]: 'pty-b' })
  })

  it('republishes a pane when its terminal registers and when its liveness turns unverifiable', () => {
    const store = partitionedStore({ local: twoPaneSession() })
    const runtime = runtimeOn(store)
    const events: PublishedWorkspaceLayout[] = []
    runtime.subscribeWorkspaceLayouts((event) => {
      if (event.type === 'workspace' && event.key === TEST_WORKTREE_ID) {
        events.push(event.layout)
      }
    })

    runtime.registerPty('pty-a', TEST_WORKTREE_ID)
    expect(statusOf(events.at(-1), HEADLESS_LEAF_ID)).toBe('running')

    runtime.markPtyLivenessUnverifiable('pty-a', 'relay out of contact')
    expect(statusOf(events.at(-1), HEADLESS_LEAF_ID)).toBe('unverifiable')
  })
})
