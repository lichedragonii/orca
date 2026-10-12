// What `layout.subscribe` serves: each workspace's published layout, replaced only for the
// workspaces an apply changed. Listeners get those changes in apply order.

import type { PublishedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-published'
import type {
  WorkspaceLayoutEvent,
  WorkspaceLayoutSnapshotEntry
} from '../../shared/workspace-layout/workspace-layout-stream-frames'

type LayoutListener = (event: WorkspaceLayoutEvent) => void

export class RuntimeWorkspaceLayoutPublication {
  private readonly listeners = new Set<LayoutListener>()
  private readonly published = new Map<string, PublishedWorkspaceLayout>()
  private failureLogged = false

  /** Every workspace's layout now, then each change until `unsubscribe`. */
  subscribe(listener: LayoutListener): {
    snapshot: WorkspaceLayoutSnapshotEntry[]
    unsubscribe: () => void
  } {
    this.listeners.add(listener)
    return {
      snapshot: [...this.published].map(([key, layout]) => ({ key, layout })),
      unsubscribe: () => {
        this.listeners.delete(listener)
      }
    }
  }

  get(key: string): PublishedWorkspaceLayout | undefined {
    return this.published.get(key)
  }

  keys(): string[] {
    return [...this.published.keys()]
  }

  /** Null removes the workspace. */
  set(key: string, layout: PublishedWorkspaceLayout | null): void {
    if (layout === null && !this.published.delete(key)) {
      return
    }
    if (layout !== null) {
      this.published.set(key, layout)
    }
    const event: WorkspaceLayoutEvent =
      layout === null ? { type: 'removed', key } : { type: 'workspace', key, layout }
    for (const listener of this.listeners) {
      // One failing listener must not cost the others an event the holder has now published.
      try {
        listener(event)
      } catch (error) {
        if (!this.failureLogged) {
          this.failureLogged = true
          console.warn('[workspace-layout] layout listener failed:', error)
        }
      }
    }
  }
}
