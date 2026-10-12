import { describe, expect, it, vi } from 'vitest'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { WorkspaceLayoutEvent } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { reloadHolderOnExternalWrites } from './holder-external-write-reload'
import { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

const SSH_HOST: ExecutionHostId = 'ssh:box'
const SERVER_HOST: ExecutionHostId = 'runtime:env-1'
const SERVER_KEY = 'repo-server::/srv/app'
const SSH_KEY = 'repo-ssh::/home/dev/api'

function fakeStore(sessions: Partial<Record<ExecutionHostId, WorkspaceSessionState>>) {
  const listeners = new Set<() => void>()
  const all: Record<string, WorkspaceSessionState> = { local: emptySession() }
  for (const [hostId, session] of Object.entries(sessions)) {
    if (session) {
      all[hostId] = session
    }
  }
  const store = {
    sessions: all,
    getWorkspaceSessionHostIds: () =>
      Object.keys(store.sessions).flatMap((id) => parseExecutionHostId(id)?.id ?? []),
    getWorkspaceSession: (hostId?: string | null) => store.sessions[hostId ?? 'local']!,
    setWorkspaceSession: vi.fn((session: WorkspaceSessionState, hostId?: string | null) => {
      store.sessions[hostId ?? 'local'] = session
      listeners.forEach((listener) => listener())
    }),
    onWorkspaceSessionWritten: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  return store
}

function holderFor(
  store: ReturnType<typeof fakeStore>,
  live = new Set<string>(),
  options: { frozen?: ExecutionHostId } = {}
) {
  const stopped: string[] = []
  const holder = new RuntimeWorkspaceLayouts({
    store: () => store,
    homeHostId: (key) => (key === SERVER_KEY ? SERVER_HOST : key === SSH_KEY ? SSH_HOST : 'local'),
    isFrozenPartition: (hostId) => hostId === options.frozen,
    terminal: (ptyId) => ({
      fact: live.has(ptyId) ? 'live' : null,
      ...(live.has(ptyId) ? { liveTitle: `title of ${ptyId}` } : {})
    }),
    stopTerminals: (ptyIds) => stopped.push(...ptyIds)
  })
  holder.load()
  const events: WorkspaceLayoutEvent[] = []
  holder.subscribe((event) => events.push(event))
  return { holder, events, stopped }
}

function gitSession(): WorkspaceSessionState {
  return addWorkspace(emptySession(), GIT_KEY, [
    { id: 'group-a', tabs: [{ id: 'tab-1', leaves: [[leaf(1), 'pty-1']] }] }
  ])
}

const panesOf = (holder: RuntimeWorkspaceLayouts, key = GIT_KEY) =>
  holder.published(key)?.tabs.flatMap((tab) => tab.terminal?.panes ?? [])

describe('RuntimeWorkspaceLayouts: the holder', () => {
  it('loads every host partition but a runtime server one, deriving pane status at publish', () => {
    const store = fakeStore({
      local: gitSession(),
      [SERVER_HOST]: addWorkspace(emptySession(), SERVER_KEY, [
        { id: 'group-s', tabs: [{ id: 'tab-s', leaves: [[leaf(5), 'pty-s']] }] }
      ]),
      [SSH_HOST]: addWorkspace(
        emptySession(),
        SSH_KEY,
        [{ id: 'group-h', tabs: [{ id: 'tab-h', leaves: [[leaf(6), 'pty-h']] }] }],
        SSH_HOST
      )
    })
    const { holder } = holderFor(store, new Set(['pty-1']))

    expect(panesOf(holder)).toEqual([
      { leafId: leaf(1), ptyId: 'pty-1', status: 'running', liveTitle: 'title of pty-1' }
    ])
    expect(holder.published(SERVER_KEY)).toBeUndefined()
    // A saved ssh: partition is a host not converted yet: its panes wait for it.
    expect(panesOf(holder, SSH_KEY)?.[0]?.status).toBe('waiting_for_host')
  })

  it('admits a pane with a start attempt that only its own spawn can bind', () => {
    const store = fakeStore({ local: gitSession() })
    const live = new Set<string>()
    const { holder, events } = holderFor(store, live)
    const admitted = holder.apply({
      type: 'splitPane',
      workspace: GIT_KEY,
      tabId: 'tab-1',
      leafId: leaf(1),
      direction: 'vertical',
      newLeafId: leaf(2)
    })
    const start = admitted.ok ? admitted.starts?.[0] : undefined
    expect(start?.paneKey).toBe(`tab-1:${leaf(2)}`)
    expect(panesOf(holder)?.[1]).toEqual({ leafId: leaf(2), status: 'starting' })
    expect(store.setWorkspaceSession).toHaveBeenCalledTimes(1)

    const started = { workspace: GIT_KEY, paneKey: start!.paneKey, ptyId: 'pty-2' }
    const superseding = holder.beginStart(start!.paneKey)!
    expect(holder.bindStarted('local', started, start!.attempt)).toBe('superseded')
    live.add('pty-2')
    expect(holder.bindStarted('local', started, superseding.attempt)).toBe('bound')
    expect(panesOf(holder)?.[1]).toMatchObject({ ptyId: 'pty-2', status: 'running' })
    expect(events.at(-1)).toMatchObject({ type: 'workspace', key: GIT_KEY })
  })

  it('applies the exit rule: a failed local process stays, an unproven exit unbinds, a used one retires', () => {
    const store = fakeStore({
      local: addWorkspace(emptySession(), GIT_KEY, [
        {
          id: 'group-a',
          tabs: [
            {
              id: 'tab-1',
              leaves: [
                [leaf(1), 'pty-1'],
                [leaf(2), 'pty-2'],
                [leaf(3), 'pty-3']
              ]
            }
          ]
        }
      ])
    })
    const { holder } = holderFor(store)
    const surface = (n: number) => ({
      worktreeId: GIT_KEY,
      terminalTabId: 'tab-1',
      leafId: leaf(n),
      ptyId: `pty-${n}`
    })
    const facts = {
      local: true,
      spawnedFresh: false,
      restored: true,
      inputWritten: true,
      outputReceived: true
    }

    expect(holder.processExited('local', surface(1), { ...facts, exitCode: 2 })).toBe('kept')
    expect(holder.processExited('local', surface(2), { ...facts, exitCode: -1 })).toBe('kept')
    expect(holder.processExited('local', surface(3), { ...facts, exitCode: 0 })).toBe('gone')
    expect(panesOf(holder)).toEqual([
      { leafId: leaf(1), ptyId: 'pty-1', status: 'exited' },
      { leafId: leaf(2), status: 'restorable' }
    ])
  })

  it('stops the processes of panes a close removes', () => {
    const store = fakeStore({ local: gitSession() })
    const { holder, stopped, events } = holderFor(store)
    holder.apply({ type: 'closeTabs', workspace: GIT_KEY, tabIds: ['tab-1'] })
    expect(stopped).toEqual(['pty-1'])
    expect(holder.published(GIT_KEY)?.tabs).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'workspace', key: GIT_KEY })
  })

  it('publishes catalog workspaces empty and removes them with the catalog entry', () => {
    const store = fakeStore({ local: gitSession() })
    const { holder, events } = holderFor(store)
    holder.addCatalogWorkspaces(['folder:new'])
    expect(holder.published('folder:new')).toMatchObject({ tabs: [], groups: [] })

    holder.removeWorkspaces(['folder:new', GIT_KEY])
    expect(holder.published(GIT_KEY)).toBeUndefined()
    expect(events.slice(-2)).toEqual([
      { type: 'removed', key: GIT_KEY },
      { type: 'removed', key: 'folder:new' }
    ])
    expect(store.sessions.local!.tabsByWorktree[GIT_KEY]).toBeUndefined()
  })

  it('drops a partition a conversion fenced instead of saving it', () => {
    const store = fakeStore({
      [SSH_HOST]: addWorkspace(
        emptySession(),
        SSH_KEY,
        [{ id: 'group-h', tabs: [{ id: 'tab-h', leaves: [[leaf(6), 'pty-h']] }] }],
        SSH_HOST
      )
    })
    const frozen = { frozen: undefined as ExecutionHostId | undefined }
    const holder = new RuntimeWorkspaceLayouts({
      store: () => store,
      homeHostId: () => SSH_HOST,
      isFrozenPartition: (hostId) => hostId === frozen.frozen,
      terminal: () => ({ fact: null }),
      stopTerminals: () => {}
    })
    holder.load()
    frozen.frozen = SSH_HOST
    holder.apply({ type: 'closeTabs', workspace: SSH_KEY, tabIds: ['tab-h'] })
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(holder.published(SSH_KEY)).toBeUndefined()
  })
})

describe('holder-external-write-reload (stack-internal bridge)', () => {
  it('reloads a partition another writer changed and keeps start attempts', () => {
    const store = fakeStore({ local: gitSession() })
    const { holder, events } = holderFor(store)
    reloadHolderOnExternalWrites(holder, store)
    const start = holder.beginStart(`tab-1:${leaf(1)}`)!
    const ownSaves = events.length

    const external = structuredClone(store.sessions.local!)
    external.tabsByWorktree[GIT_KEY]![0]!.customTitle = 'Renamed by the window'
    store.setWorkspaceSession(external, 'local')

    expect(holder.published(GIT_KEY)?.tabs[0]?.customTitle).toBe('Renamed by the window')
    expect(events.length).toBe(ownSaves + 1)
    expect(panesOf(holder)?.[0]?.status).toBe('starting')
    expect(holder.starts.isStarting(leaf(1))).toBe(true)
    expect(start.attempt).toBeTruthy()
  })

  it('does not reload the holder’s own saves', () => {
    const store = fakeStore({ local: gitSession() })
    const { holder, events } = holderFor(store)
    reloadHolderOnExternalWrites(holder, store)
    holder.apply({
      type: 'renameTab',
      workspace: GIT_KEY,
      tabId: 'tab-1',
      kind: 'custom',
      title: 'Mine'
    })
    expect(events).toHaveLength(1)
    expect(store.sessions.local!.tabsByWorktree[GIT_KEY]![0]!.customTitle).toBe('Mine')
  })
})
