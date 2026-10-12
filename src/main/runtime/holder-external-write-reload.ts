// Stack-internal bridge (PR 6a until 6g; never reaches main alone). Until 6g, old writers (the
// window's session saves, pty:spawn bindings, headless tab edits, Store-internal catalog writers)
// still write the Store directly. When a host partition the holder holds was last written by
// someone else, it is reloaded into the holder through the Loader, so the holder's next save does
// not erase that write. Start attempts, last outcomes and exit facts are kept by leaf id. Runs on
// each Store write notice and before each holder read. Deleted in 6g with the last external writer.

import type { ExecutionHostId } from '../../shared/execution-host'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'
import type { HolderStore } from './runtime-workspace-layout-writer'
import type { RuntimeStore } from './runtime-store-contract'

export function reloadHolderOnExternalWrites(
  holder: RuntimeWorkspaceLayouts,
  store: HolderStore & Pick<RuntimeStore, 'onWorkspaceSessionWritten'>
): void {
  const reloadIfWrittenElsewhere = (hostId: ExecutionHostId): void => {
    const session = store.getWorkspaceSession(hostId)
    if (holder.isSaving() || session === holder.savedSession(hostId)) {
      return
    }
    const { changes: _changes, ...loaded } = loadWorkspaceLayout(
      hostId,
      session,
      nameBasedLoadContext()
    )
    holder.replacePartition(hostId, session, loaded)
  }
  holder.setExternalWriteCheck(reloadIfWrittenElsewhere)
  store.onWorkspaceSessionWritten?.(() => {
    for (const hostId of store.getWorkspaceSessionHostIds()) {
      // A partition the holder has not read yet loads on first use.
      if (holder.loadedHostIds().includes(hostId)) {
        reloadIfWrittenElsewhere(hostId)
      } else {
        holder.model(hostId)
      }
    }
  })
}
