// What the holder joins to its model at publish and at an exit: each pane's derived status and
// live title, and which panes a model holds.

import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { leafIdsOf } from '../../shared/workspace-layout/workspace-layout-command-steps'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import {
  derivePaneStatus,
  type PaneTerminalFact
} from '../../shared/workspace-layout/workspace-layout-pane-status'
import type {
  PublishedPaneFacts,
  PublishedWorkspaceLayout
} from '../../shared/workspace-layout/workspace-layout-published'
import { findTerminalTab } from '../../shared/workspace-layout/workspace-layout-removal'
import type { RuntimePaneStartAttempts } from './runtime-pane-start-attempts'
import type { HolderStore } from './runtime-workspace-layout-writer'

/** What the PTY registry knows of a bound pane's terminal. */
export type TerminalFacts = (ptyId: string) => { fact: PaneTerminalFact; liveTitle?: string }

export type RuntimeWorkspaceLayoutsDeps = {
  store: () => HolderStore | null
  /** The partition that owns a workspace key; null when none does. */
  homeHostId: (key: string) => ExecutionHostId | null
  /** A partition an orcad conversion froze for downgrade; it can be fenced mid-session. */
  isFrozenPartition: (hostId: ExecutionHostId) => boolean
  /** What the PTY registry knows of a bound pane's terminal. */
  terminal: TerminalFacts
  stopTerminals: (ptyIds: readonly string[]) => void
}

/** A catalog workspace with no tabs. */
export function emptyPublishedWorkspace(key: string): PublishedWorkspaceLayout {
  return { worktreeId: key, groups: [], tabs: [], editorFiles: [], browserTabs: [] }
}

export function terminalLeafIds(model: WorkspaceLayoutModel): Set<string> {
  return new Set(
    Object.values(model.workspaces).flatMap((workspace) =>
      workspace.tabs.flatMap((tab) => (tab.kind === 'terminal' ? leafIdsOf(tab) : []))
    )
  )
}

/** Whether another pane of this pane's tab has a terminal. */
export function tabHasOtherBoundPane(model: WorkspaceLayoutModel, paneKey: string): boolean {
  const parsed = parsePaneKey(paneKey)
  const location = parsed ? findTerminalTab(model, parsed.tabId) : null
  if (!parsed || !location) {
    return false
  }
  const leaves = model.workspaces[location.workspaceKey]!.leaves
  return leafIdsOf(location.tab).some(
    (leafId) => leafId !== parsed.leafId && leaves?.[leafId]?.ptyId !== undefined
  )
}

export function holderPaneFacts(
  hostId: ExecutionHostId,
  starts: RuntimePaneStartAttempts,
  terminalFacts: TerminalFacts
): PublishedPaneFacts {
  // A saved `ssh:` partition is a host not yet converted: this runtime cannot start there.
  const host = parseExecutionHostId(hostId)?.kind === 'ssh' ? 'awaiting' : 'reachable'
  return ({ leafId, leaf }) => {
    const terminal = leaf?.ptyId ? terminalFacts(leaf.ptyId) : null
    const status = derivePaneStatus({
      starting: starts.isStarting(leafId),
      lastOutcome: starts.outcome(leafId),
      sleeping: leaf?.sleeping !== undefined,
      terminal: terminal?.fact ?? null,
      host
    })
    return { status, ...(terminal?.liveTitle ? { liveTitle: terminal.liveTitle } : {}) }
  }
}
