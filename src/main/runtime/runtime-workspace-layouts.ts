// The holder: the runtime's one copy of every host partition's tab layout. It applies commands and
// transitions synchronously through the pure layout module, saves from its own memory and
// publishes only the workspaces an apply changed. `runtime:<env>` partitions never enter it.

import { randomUUID } from 'node:crypto'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Applied } from '../../shared/workspace-layout/workspace-layout-command-steps'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import type {
  LayoutCommand,
  LayoutRefusalCode
} from '../../shared/workspace-layout/workspace-layout-command-types'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { PaneOutcome } from '../../shared/workspace-layout/workspace-layout-pane-outcomes'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import type { ProcessExitFacts } from '../../shared/workspace-layout/workspace-layout-process-exit'
import {
  findTerminalTab,
  locateExitedSurface,
  type ExitedSurface
} from '../../shared/workspace-layout/workspace-layout-removal'
import {
  applyLayoutTransition,
  type LayoutTransition
} from '../../shared/workspace-layout/workspace-layout-transitions'
import { RuntimePaneStartAttempts, type PaneStart } from './runtime-pane-start-attempts'
import {
  emptyPublishedWorkspace,
  holderPaneFacts,
  tabHasOtherBoundPane,
  terminalLeafIds,
  type RuntimeWorkspaceLayoutsDeps
} from './runtime-workspace-layout-pane-facts'
import { RuntimeWorkspaceLayoutPublication } from './runtime-workspace-layout-publication'
import { DURABLE_COMMANDS, RuntimeWorkspaceLayoutWriter } from './runtime-workspace-layout-writer'

export type HolderApplied = Applied & { starts?: PaneStart[] }

export class RuntimeWorkspaceLayouts {
  private readonly partitions = new Map<ExecutionHostId, LoadedWorkspaceLayout>()
  /** Local catalog workspaces: published, empty when they have no tabs. */
  private readonly catalog = new Set<string>()
  private readonly publication = new RuntimeWorkspaceLayoutPublication()
  readonly starts = new RuntimePaneStartAttempts()
  private readonly writer: RuntimeWorkspaceLayoutWriter
  private externalWriteCheck: ((hostId: ExecutionHostId) => void) | null = null

  constructor(private readonly deps: RuntimeWorkspaceLayoutsDeps) {
    this.writer = new RuntimeWorkspaceLayoutWriter(deps.store)
  }

  /** Loads every host partition the Store holds. Nothing starts: unbound panes are restorable. */
  load(): void {
    for (const hostId of this.deps.store()?.getWorkspaceSessionHostIds() ?? []) {
      this.partition(hostId)
    }
  }

  subscribe(
    listener: Parameters<RuntimeWorkspaceLayoutPublication['subscribe']>[0]
  ): ReturnType<RuntimeWorkspaceLayoutPublication['subscribe']> {
    return this.publication.subscribe(listener)
  }

  published(key: string): PublishedWorkspaceLayout | undefined {
    return this.publication.get(key)
  }

  /** Whether this holder writes the partition: no `runtime:<env>` and no frozen orcad source. */
  holds(hostId: ExecutionHostId): boolean {
    return parseExecutionHostId(hostId)?.kind !== 'runtime' && !this.deps.isFrozenPartition(hostId)
  }

  model(hostId: ExecutionHostId): WorkspaceLayoutModel | null {
    return this.partition(hostId)?.layout ?? null
  }

  /** The Store's partition object as of this holder's last own write, for the bridge. */
  savedSession(hostId: ExecutionHostId): WorkspaceSessionState | undefined {
    return this.writer.savedSession(hostId)
  }

  isSaving(): boolean {
    return this.writer.isWriting()
  }

  loadedHostIds(): ExecutionHostId[] {
    return [...this.partitions.keys()]
  }

  apply(command: LayoutCommand, hostId = this.hostIdOf(command.workspace)): HolderApplied {
    const loaded = hostId ? this.partition(hostId) : null
    if (!hostId || !loaded) {
      return { ok: false, code: 'workspace_not_found' }
    }
    const result = applyLayoutCommand(loaded.layout, command, {
      mintId: randomUUID,
      mintLeafId: randomUUID,
      now: Date.now,
      isStarting: (leafId) => this.starts.isStarting(leafId)
    })
    return result.ok ? this.commit(hostId, result, DURABLE_COMMANDS.has(command.type)) : result
  }

  transition(hostId: ExecutionHostId, transition: LayoutTransition): HolderApplied {
    const loaded = this.partition(hostId)
    if (!loaded) {
      return { ok: false, code: 'workspace_not_found' }
    }
    const result = applyLayoutTransition(loaded.layout, transition)
    return result.ok ? this.commit(hostId, result, true) : result
  }

  /** The workspace and tab-bar id of a terminal tab, by its terminal tab id. */
  findTerminalTab(
    terminalTabId: string
  ): { hostId: ExecutionHostId; workspace: string; tabId: string } | null {
    for (const hostId of this.loadedHostIds()) {
      const location = findTerminalTab(this.partition(hostId)!.layout, terminalTabId)
      if (location) {
        return { hostId, workspace: location.workspaceKey, tabId: location.tab.id }
      }
    }
    return null
  }

  /** A fresh attempt for a pane already in the layout, as when a start attaches to it. */
  beginStart(paneKey: string): PaneStart | null {
    const leafId = parsePaneKey(paneKey)?.leafId
    return leafId ? { paneKey, attempt: this.starts.begin(leafId) } : null
  }

  /**
   * Binds a started terminal to its pane only when it carries the pane's current attempt;
   * 'superseded' tells the caller to stop it.
   */
  bindStarted(
    hostId: ExecutionHostId,
    started: { workspace: string; paneKey: string; ptyId: string; incarnationId?: string },
    attempt: string
  ): 'bound' | 'superseded' | LayoutRefusalCode {
    const leafId = parsePaneKey(started.paneKey)?.leafId
    if (!leafId || !this.starts.settle(leafId, attempt)) {
      return 'superseded'
    }
    const model = this.partitions.get(hostId)?.layout
    this.starts.noteConnect(leafId, model ? tabHasOtherBoundPane(model, started.paneKey) : false)
    const result = this.transition(hostId, { type: 'processStarted', ...started })
    if (!result.ok) {
      // The attempt ended either way; its pane is no longer starting.
      this.republish(hostId, started.workspace)
    }
    return result.ok ? 'bound' : result.code
  }

  /**
   * A terminal exited: today's window rule decides whether its pane is kept to show why, unbound
   * (an unproven exit, attach absence) or retired. `replaced` when the pane shows another
   * terminal now, `kept` when it stays.
   */
  processExited(
    hostId: ExecutionHostId,
    surface: ExitedSurface,
    exit: Omit<ProcessExitFacts, 'tabHadPaneAtConnect'>
  ): 'gone' | 'kept' | 'replaced' {
    const model = this.partition(hostId)?.layout
    if (!model || locateExitedSurface(model, surface) === 'replaced') {
      return model ? 'replaced' : 'gone'
    }
    const tabHadPaneAtConnect = this.starts.hadSiblingAtConnect(surface.leafId)
    this.transition(hostId, {
      type: 'processExited',
      surface,
      exit: { ...exit, tabHadPaneAtConnect }
    })
    const after = this.partitions.get(hostId)?.layout
    return !after || locateExitedSurface(after, surface) === 'gone' ? 'gone' : 'kept'
  }

  /** Ends an attempt that will not bind; `failed` keeps the pane to show its error. */
  endStart(
    hostId: ExecutionHostId,
    workspace: string,
    start: PaneStart,
    outcome: PaneOutcome | null
  ): void {
    const leafId = parsePaneKey(start.paneKey)?.leafId
    if (leafId && this.starts.settle(leafId, start.attempt)) {
      this.starts.applyOutcomes({ [leafId]: outcome })
      this.republish(hostId, workspace)
    }
  }

  /** Each local catalog workspace is published, empty when it has no tabs. */
  addCatalogWorkspaces(keys: readonly string[]): void {
    for (const key of keys) {
      if (!this.catalog.has(key)) {
        this.catalog.add(key)
        this.publish(key)
      }
    }
  }

  /** A catalog removal: the workspace and its records leave the model, and its entry is removed. */
  removeWorkspaces(keys: readonly string[]): void {
    for (const key of keys) {
      this.catalog.delete(key)
    }
    for (const hostId of this.loadedHostIds()) {
      const present = keys.filter((key) => this.partitions.get(hostId)?.layout.workspaces[key])
      if (present.length > 0) {
        this.transition(hostId, { type: 'ownerRemoved', workspaces: present })
      }
    }
    for (const key of keys) {
      this.publish(key)
    }
  }

  /** A fact beside the model changed (a terminal registered, its title): republish its workspace. */
  republish(hostId: ExecutionHostId, key: string): void {
    if (this.hostIdOf(key) === hostId) {
      this.publish(key)
    }
  }

  /** Republishes every workspace showing this terminal. */
  republishTerminal(ptyId: string): void {
    for (const [hostId, loaded] of this.partitions) {
      for (const [key, workspace] of Object.entries(loaded.layout.workspaces)) {
        if (Object.values(workspace.leaves ?? {}).some((leaf) => leaf.ptyId === ptyId)) {
          this.republish(hostId, key)
        }
      }
    }
  }

  /** Replaces a partition loaded from a write this holder did not make (stack-internal bridge). */
  replacePartition(
    hostId: ExecutionHostId,
    session: WorkspaceSessionState,
    loaded: LoadedWorkspaceLayout
  ): void {
    const before = this.partitions.get(hostId)
    this.partitions.set(hostId, loaded)
    this.writer.noteRead(hostId, session)
    const keys = new Set([
      ...Object.keys(before?.layout.workspaces ?? {}),
      ...Object.keys(loaded.layout.workspaces)
    ])
    for (const key of keys) {
      this.publish(key)
    }
  }

  /** Stack-internal bridge (deleted in 6g): reloads a held partition another writer changed. */
  setExternalWriteCheck(check: (hostId: ExecutionHostId) => void): void {
    this.externalWriteCheck = check
  }

  hostIdOf(key: string): ExecutionHostId | null {
    return this.deps.homeHostId(key)
  }

  private partition(hostId: ExecutionHostId): LoadedWorkspaceLayout | null {
    if (this.partitions.has(hostId)) {
      this.externalWriteCheck?.(hostId)
      return this.partitions.get(hostId)!
    }
    const store = this.deps.store()
    if (!store || !this.holds(hostId)) {
      return null
    }
    const session = store.getWorkspaceSession(hostId)
    const { changes: _changes, ...loaded } = loadWorkspaceLayout(
      hostId,
      session,
      nameBasedLoadContext()
    )
    this.partitions.set(hostId, loaded)
    this.writer.noteRead(hostId, session)
    for (const key of Object.keys(loaded.layout.workspaces)) {
      this.publish(key)
    }
    return loaded
  }

  private commit(
    hostId: ExecutionHostId,
    result: Extract<Applied, { ok: true }>,
    durable: boolean
  ): HolderApplied {
    const before = this.partitions.get(hostId)!
    this.partitions.set(hostId, { ...before, layout: result.model })
    this.starts.applyOutcomes(result.outcomes)
    const remaining = terminalLeafIds(result.model)
    this.starts.forget([...terminalLeafIds(before.layout)].filter((id) => !remaining.has(id)))
    const starts = result.effects.startPaneKeys.flatMap((paneKey) => this.beginStart(paneKey) ?? [])
    if (result.effects.stopPtyIds.length > 0) {
      this.deps.stopTerminals(result.effects.stopPtyIds)
    }
    this.save(hostId, durable)
    const keys = new Set([
      ...Object.keys(before.layout.workspaces),
      ...Object.keys(result.model.workspaces)
    ])
    for (const key of keys) {
      if (before.layout.workspaces[key] !== result.model.workspaces[key]) {
        this.republish(hostId, key)
      }
    }
    return starts.length > 0 ? { ...result, starts } : result
  }

  private save(hostId: ExecutionHostId, durable: boolean): void {
    const loaded = this.partitions.get(hostId)
    if (this.deps.isFrozenPartition(hostId)) {
      this.dropPartition(hostId)
    } else if (loaded) {
      this.writer.write(hostId, loaded, durable)
    }
  }

  /** A partition fenced by a conversion leaves the model; its host now serves its workspaces. */
  private dropPartition(hostId: ExecutionHostId): void {
    const loaded = this.partitions.get(hostId)
    this.partitions.delete(hostId)
    this.writer.forget(hostId)
    for (const key of Object.keys(loaded?.layout.workspaces ?? {})) {
      this.publish(key)
    }
  }

  private publish(key: string): void {
    const hostId = this.hostIdOf(key)
    const loaded = hostId ? this.partitions.get(hostId) : undefined
    const workspace = loaded?.layout.workspaces[key]
    if (hostId && workspace) {
      const facts = holderPaneFacts(hostId, this.starts, this.deps.terminal)
      this.publication.set(key, publishWorkspaceLayout(workspace, hostId, facts))
    } else {
      this.publication.set(key, this.catalog.has(key) ? emptyPublishedWorkspace(key) : null)
    }
  }
}
