// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTouchMobileSessionTabsForWorktree } from './orca-runtime-touch-mobile-session-tabs-for-worktree'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { RuntimeMobileSessionRetiredTerminalSurface } from '../../shared/runtime-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { ProcessExitFacts } from '../../shared/workspace-layout/workspace-layout-process-exit'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import { attachRetirementProofsToSnapshot } from './mobile-session-terminal-retirement-proof'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

export class OrcaRuntimeWithPersistTerminalSurfaceRetirements extends OrcaRuntimeWithTouchMobileSessionTabsForWorktree {
  /**
   * Applies the exit to each surface's pane in the holder, in the partition of the host that owns
   * its worktree. `accepted` left the layout (retired, or already gone); a pane the exit rule keeps
   * or only unbinds is in neither list. `unpersisted` had no partition to hold it.
   */
  protected stageTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[],
    exit: Omit<ProcessExitFacts, 'tabHadPaneAtConnect'>
  ): {
    accepted: RetiredTerminalSurface[]
    unpersisted: RetiredTerminalSurface[]
  } {
    const accepted: RetiredTerminalSurface[] = []
    const unpersisted: RetiredTerminalSurface[] = []
    for (const surface of retiredSurfaces) {
      const hostId =
        this.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ?? LOCAL_EXECUTION_HOST_ID
      if (!this.layoutHolder.model(hostId)) {
        unpersisted.push(surface)
        continue
      }
      const exited = {
        worktreeId: surface.worktreeId,
        terminalTabId: surface.parentTabId,
        leafId: surface.leafId,
        ptyId: surface.ptyId,
        ...(surface.incarnationId ? { incarnationId: surface.incarnationId } : {})
      }
      if (this.layoutHolder.processExited(hostId, exited, exit) === 'gone') {
        accepted.push(surface)
      }
    }
    return { accepted, unpersisted }
  }

  // Why synchronous: the exit's stream end cues clients to re-activate, which must find the leaf gone.
  protected retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[],
    exit: Omit<ProcessExitFacts, 'tabHadPaneAtConnect'>
  ): void {
    const terminalHandle =
      this.handleByPtyId.get(ptyId) ?? this.findHandleForPtyRecord(ptyId) ?? undefined
    const retiredSurfaceByKey = new Map<string, RetiredTerminalSurface>()
    for (const surface of exactSurfaces) {
      retiredSurfaceByKey.set(`${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`, {
        ...surface,
        ptyId,
        incarnationId
      })
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: exactSurfaces.filter((surface) => surface.worktreeId === worktreeId),
        exactOnly: exactSurfaces.length > 0
      })
      if (!retired) {
        continue
      }
      for (const surface of retired.retired) {
        retiredSurfaceByKey.set(
          `${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`,
          { ...surface, incarnationId }
        )
      }
    }
    const retiredSurfaces = [...retiredSurfaceByKey.values()]
    if (retiredSurfaces.length === 0) {
      return
    }
    const staged = this.stageTerminalSurfaceRetirements(retiredSurfaces, exit)
    for (const surface of staged.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.terminalTopologyRevisionByRepoId.set(
        repoId,
        (this.terminalTopologyRevisionByRepoId.get(repoId) ?? 0) + 1
      )
    }
    // Why: one repo epoch can cover multiple exits; a surface the session binds to another PTY or incarnation stays.
    const removableRetiredSurfaces = [...staged.accepted, ...staged.unpersisted]
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      // Why proofs aren't gated on `removable`: the exit is the attestation, and a surface the
      // renderer already de-persisted leaves persistence nothing to accept. Withholding the proof
      // then strands the mirror's pane until a second inventory a quiet workspace never sends.
      const retirementProofs = terminalHandle
        ? retiredSurfaces
            .filter((surface) => surface.worktreeId === worktreeId)
            .map((surface) => ({
              parentTabId: surface.parentTabId,
              leafId: surface.leafId,
              ptyId: surface.ptyId,
              terminal: terminalHandle,
              incarnationId
            }))
        : []
      const removableSurfaces = removableRetiredSurfaces.filter(
        (surface) => surface.worktreeId === worktreeId
      )
      const retired =
        removableSurfaces.length > 0
          ? retireTerminalSurfacesFromSnapshot({
              snapshot,
              ptyId,
              exactSurfaces: removableSurfaces,
              // Why: discovery is broad by PTY id, but publication may remove only surfaces the session retired.
              exactOnly: true,
              ...(retirementProofs.length > 0 ? { retirementProofs } : {})
            })
          : null
      if (retired) {
        this.storeMobileSessionSnapshot(worktreeId, retired.snapshot)
        this.notifyMobileSessionTabsChanged(worktreeId)
        continue
      }
      this.publishRetiredTerminalSurfaceProofs(worktreeId, retirementProofs)
    }
  }

  /** Ships durable retirement proofs on their own frame when no surface removal carries them. */
  protected publishRetiredTerminalSurfaceProofs(
    worktreeId: string,
    proofs: readonly RuntimeMobileSessionRetiredTerminalSurface[]
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    const next = attachRetirementProofsToSnapshot(snapshot, proofs)
    if (!next) {
      return
    }
    this.storeMobileSessionSnapshot(worktreeId, next)
    this.notifyMobileSessionTabsChanged(worktreeId)
  }
}
