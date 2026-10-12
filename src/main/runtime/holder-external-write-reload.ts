// Stack-internal bridge (PR 6a until 6g; never reaches main alone). Until 6g, old writers (the
// window's session saves, pty:spawn bindings, headless tab edits) still write the Store directly.
// When a write is not the holder's own save, the written partition is reloaded into the holder so
// its next save does not erase that write. Start attempts and last outcomes are kept by leaf id.
// Deleted in 6g with the last external writer.

import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../shared/workspace-layout/workspace-layout-load-report'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'
import type { HolderStore } from './runtime-workspace-layout-writer'
import type { RuntimeStore } from './runtime-store-contract'

export function reloadHolderOnExternalWrites(
  holder: RuntimeWorkspaceLayouts,
  store: HolderStore & Required<Pick<RuntimeStore, 'onWorkspaceSessionWritten'>>
): () => void {
  return store.onWorkspaceSessionWritten(() => {
    if (holder.isSaving()) {
      return
    }
    for (const hostId of store.getWorkspaceSessionHostIds()) {
      const before = holder.model(hostId)
      const session = store.getWorkspaceSession(hostId)
      if (!before || session === holder.savedSession(hostId)) {
        continue
      }
      const { changes: _changes, ...loaded } = loadWorkspaceLayout(
        hostId,
        session,
        nameBasedLoadContext()
      )
      const keys = new Set([
        ...Object.keys(before.workspaces),
        ...Object.keys(loaded.layout.workspaces)
      ])
      const changed = [...keys].filter(
        (key) =>
          stableJson(before.workspaces[key] ?? null) !==
          stableJson(loaded.layout.workspaces[key] ?? null)
      )
      holder.replacePartition(hostId, loaded, changed)
    }
  })
}
