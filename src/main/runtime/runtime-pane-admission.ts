import { toSshExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { locatePane } from '../../shared/workspace-layout/workspace-layout-command-steps'
import type { CommandOf } from '../../shared/workspace-layout/workspace-layout-command-types'
import { paneKeyOf } from '../../shared/workspace-layout/workspace-layout-model'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { PaneStart, RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

type Spawn = NonNullable<RuntimePtyController['spawn']>
type AdmittedSpawnArgs = Parameters<Spawn>[0] & {
  worktreeId: string
  tabId: string
  leafId: string
  /** The group a new tab joins; a split stays in its parent's. */
  groupId?: string
}

/** A new tab, or a split of an existing pane, with the ids its terminal will run under. */
type TerminalPaneAdmission =
  | (CommandOf<'createTerminalTab'> & { tabId: string; leafId: string })
  | (CommandOf<'splitPane'> & { newLeafId: string })

/** The pane its placement names: a new tab, or a split beside its parent pane. */
function admissionFor(args: AdmittedSpawnArgs): TerminalPaneAdmission {
  const { worktreeId: workspace, tabId, leafId, placement } = args
  if (placement?.kind === 'split') {
    const { parentLeafId, direction } = placement
    return {
      type: 'splitPane',
      workspace,
      tabId,
      leafId: parentLeafId,
      direction,
      newLeafId: leafId
    }
  }
  const viewMode = placement?.kind === 'new-tab' ? placement.row?.viewMode : undefined
  return {
    type: 'createTerminalTab',
    workspace,
    tabId,
    leafId,
    ...(args.groupId ? { groupId: args.groupId } : {}),
    ...(viewMode ? { viewMode } : {}),
    ...(args.cwd ? { creation: { startupCwd: args.cwd } } : {})
  }
}

function hostIdOf(args: AdmittedSpawnArgs) {
  return args.connectionId ? toSshExecutionHostId(args.connectionId) : LOCAL_EXECUTION_HOST_ID
}

/** Takes back a pane the runtime admitted for a start that then failed, so it leaves no tab. */
export function withdrawRuntimePane(
  holder: RuntimeWorkspaceLayouts,
  args: AdmittedSpawnArgs
): void {
  holder.apply(
    { type: 'closePane', workspace: args.worktreeId, tabId: args.tabId, leafId: args.leafId },
    hostIdOf(args)
  )
}

/** Admits the pane in the holder, or starts a new attempt when it is already there. */
function admit(
  holder: RuntimeWorkspaceLayouts,
  args: AdmittedSpawnArgs
): { start: PaneStart; admitted: boolean } {
  const hostId = hostIdOf(args)
  const paneKey = paneKeyOf(args.tabId, args.leafId)
  const workspace = holder.model(hostId)?.workspaces[args.worktreeId]
  const existing = workspace && locatePane(workspace, paneKey) ? holder.beginStart(paneKey) : null
  if (existing) {
    return { start: existing, admitted: false }
  }
  const applied = holder.apply(admissionFor(args), hostId)
  const start = applied.ok ? applied.starts?.[0] : undefined
  if (!start) {
    // Only a split is refused: its parent pane left the layout.
    throw new Error('terminal_split_source_not_found')
  }
  return { start, admitted: true }
}

/**
 * Starts a runtime-originated terminal (design 4.1): the holder admits its pane, tab-bar entry and
 * group first, then the process starts and binds to that pane with the attempt it was admitted
 * under. A start that fails, or that attaches to a session already running in another pane, takes
 * back the pane it admitted.
 */
export async function spawnInAdmittedPane(
  holder: RuntimeWorkspaceLayouts,
  controller: Required<Pick<RuntimePtyController, 'spawn' | 'kill'>>,
  args: AdmittedSpawnArgs
): ReturnType<Spawn> {
  const { start, admitted } = admit(holder, args)
  const { groupId: _groupId, ...spawnArgs } = args
  let result: Awaited<ReturnType<Spawn>>
  try {
    result = await controller.spawn(spawnArgs)
  } catch (error) {
    if (admitted) {
      withdrawRuntimePane(holder, args)
    } else {
      holder.endStart(hostIdOf(args), args.worktreeId, start, 'failed')
    }
    throw error
  }
  const owner = result.agentSessionEnsure?.owner.surface ?? result.stablePaneOwner
  const elsewhere = owner && (owner.tabId !== args.tabId || owner.leafId !== args.leafId)
  if (elsewhere) {
    // The session already runs in its own pane, which keeps its binding.
    if (admitted) {
      withdrawRuntimePane(holder, args)
    } else {
      holder.endStart(hostIdOf(args), args.worktreeId, start, null)
    }
    return result
  }
  const started = {
    workspace: args.worktreeId,
    paneKey: start.paneKey,
    ptyId: result.id,
    ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
  }
  const bound = holder.bindStarted(hostIdOf(args), started, start.attempt)
  if (bound !== 'bound') {
    // A newer start of this pane, or its close, overtook this one: this terminal is not its.
    controller.kill(result.id)
    throw new Error(
      bound === 'superseded' ? 'terminal_pane_owner_changed' : 'terminal_split_source_not_found'
    )
  }
  return result
}
