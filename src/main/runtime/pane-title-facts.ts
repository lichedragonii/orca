// The one module every main producer of a terminal tab's or pane's title goes through: OSC titles
// a PTY reports (live, joined at publish) and titles saved on the tab (holder transitions).

import type { RuntimeWorkspaceLayouts } from './runtime-workspace-layouts'

export class PaneTitleFacts {
  constructor(private readonly layouts: RuntimeWorkspaceLayouts) {}

  /** The PTY's tracker recorded a new title: every pane showing it republishes its live title. */
  terminalTitleObserved(ptyId: string): void {
    this.layouts.republishTerminal(ptyId)
  }

  /** A title the user or the runtime set on a terminal tab; null clears it. */
  setCustomTitle(terminalTabId: string, title: string | null): void {
    const located = this.layouts.findTerminalTab(terminalTabId)
    if (located) {
      this.layouts.apply(
        {
          type: 'renameTab',
          workspace: located.workspace,
          tabId: located.tabId,
          kind: 'custom',
          title
        },
        located.hostId
      )
    }
  }
}
