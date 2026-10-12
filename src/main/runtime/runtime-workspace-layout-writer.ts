// The holder's saves: each partition written from the holder's memory through the Serializer, on
// today's Store scheduling. Memory is never rolled back: a failed write is logged and the next
// save writes the latest state.

import type { ExecutionHostId } from '../../shared/execution-host'
import type { LayoutCommand } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { LoadedWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load-types'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { RuntimeStore } from './runtime-store-contract'

export type HolderStore = Required<
  Pick<RuntimeStore, 'getWorkspaceSession' | 'getWorkspaceSessionHostIds' | 'setWorkspaceSession'>
> &
  Pick<RuntimeStore, 'runDurableMutation'>

/** The Store's session methods the holder uses; null for a runtime built without them. */
export function holderStoreOf(store: RuntimeStore | null): HolderStore | null {
  if (!store?.getWorkspaceSession || !store.setWorkspaceSession) {
    return null
  }
  return {
    getWorkspaceSession: (hostId) => store.getWorkspaceSession!(hostId),
    // A Store that lists no partitions holds only the local one.
    getWorkspaceSessionHostIds: () => store.getWorkspaceSessionHostIds?.() ?? ['local'],
    setWorkspaceSession: (session, hostId) => store.setWorkspaceSession!(session, hostId),
    ...(store.runDurableMutation
      ? { runDurableMutation: (mutate) => store.runDurableMutation!(mutate) }
      : {})
  }
}

/** Commands written to disk at once, as structural changes are today; the rest on the debounce. */
export const DURABLE_COMMANDS = new Set<LayoutCommand['type']>([
  'createTerminalTab',
  'splitPane',
  'closePane',
  'closeTabs',
  'movePaneToNewTab'
])

export class RuntimeWorkspaceLayoutWriter {
  /** Host id → the Store's partition object after the holder's last own write or load. */
  private readonly saved = new Map<ExecutionHostId, WorkspaceSessionState>()
  private writing = false
  private failureLogged = false

  constructor(private readonly store: () => HolderStore | null) {}

  isWriting(): boolean {
    return this.writing
  }

  savedSession(hostId: ExecutionHostId): WorkspaceSessionState | undefined {
    return this.saved.get(hostId)
  }

  noteRead(hostId: ExecutionHostId, session: WorkspaceSessionState): void {
    this.saved.set(hostId, session)
  }

  forget(hostId: ExecutionHostId): void {
    this.saved.delete(hostId)
  }

  /** `durable`: written to disk now, as structural changes are today; else on the debounce. */
  write(hostId: ExecutionHostId, loaded: LoadedWorkspaceLayout, durable: boolean): void {
    const store = this.store()
    if (!store) {
      return
    }
    this.writing = true
    try {
      store.setWorkspaceSession(saveWorkspaceLayout(loaded), hostId)
      this.saved.set(hostId, store.getWorkspaceSession(hostId))
      this.failureLogged = false
    } catch (error) {
      this.logFailure(error)
      return
    } finally {
      this.writing = false
    }
    if (durable) {
      store
        .runDurableMutation?.(() => ({ value: undefined, persist: 'if-dirty' }))
        .catch((error: unknown) => this.logFailure(error))
    }
  }

  private logFailure(error: unknown): void {
    if (!this.failureLogged) {
      this.failureLogged = true
      console.error('[workspace-layout] could not save the layout:', error)
    }
  }
}
