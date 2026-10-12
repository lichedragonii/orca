// The holder's in-memory pane facts beside the model: J, the start-attempt token minted with each
// start effect, each pane's last outcome and what its exit rule needs from its connect. None is saved, so a relaunch makes every unbound
// pane restorable again.

import { randomUUID } from 'node:crypto'
import {
  applyPaneOutcomeChanges,
  type PaneOutcome,
  type PaneOutcomeChanges,
  type PaneOutcomes
} from '../../shared/workspace-layout/workspace-layout-pane-outcomes'

/** A start an apply asked for, with the attempt token its spawn completion must carry. */
export type PaneStart = { paneKey: string; attempt: string }

export class RuntimePaneStartAttempts {
  /** Leaf id → the token of its start in flight. Leaf ids are UUIDs, unique across partitions. */
  private readonly attempts = new Map<string, string>()
  private outcomes: PaneOutcomes = {}
  /** Leaf id → another pane of its tab had a terminal when this pane's terminal bound. */
  private readonly siblingAtConnect = new Map<string, boolean>()

  /** A new attempt supersedes any in flight: that one's completion no longer matches. */
  begin(leafId: string): string {
    const attempt = randomUUID()
    this.attempts.set(leafId, attempt)
    return attempt
  }

  isStarting(leafId: string): boolean {
    return this.attempts.has(leafId)
  }

  /** Ends the attempt if it is the current one; true when it was. */
  settle(leafId: string, attempt: string): boolean {
    if (this.attempts.get(leafId) !== attempt) {
      return false
    }
    this.attempts.delete(leafId)
    return true
  }

  noteConnect(leafId: string, siblingBound: boolean): void {
    this.siblingAtConnect.set(leafId, siblingBound)
  }

  hadSiblingAtConnect(leafId: string): boolean {
    return this.siblingAtConnect.get(leafId) ?? false
  }

  outcome(leafId: string): PaneOutcome | null {
    return this.outcomes[leafId] ?? null
  }

  applyOutcomes(changes: PaneOutcomeChanges | undefined): void {
    this.outcomes = applyPaneOutcomeChanges(this.outcomes, changes)
  }

  /** A pane that left the layout leaves no attempt or outcome behind. */
  forget(leafIds: Iterable<string>): void {
    const removed: Record<string, null> = {}
    for (const leafId of leafIds) {
      this.attempts.delete(leafId)
      this.siblingAtConnect.delete(leafId)
      removed[leafId] = null
    }
    this.applyOutcomes(removed)
  }
}
