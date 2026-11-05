import { getAgentColorStyles, isAgentColor } from '@brainstrike/types/agent-color';
import type { CSSProperties, ReactElement } from 'react';
import {
  ASSISTANT_THREAD_ICON_PRESENTATION,
  getThreadTint,
  THREAD_CONTROL_TITLE_CLASS_NAME,
  THREAD_PANEL_ROW_CLASS_NAME,
} from './assistant-thread-presentation';
import type { DelegatedSidebarRow } from './delegated-sidebar-rows';
import { hostChildWorkspaceTabId } from './host-child-workspace-tab';
import { ThreadMarkChip } from './thread-identity-mark';
import { threadWorkspaceNavigation } from './thread-workspace/live-thread-workspace-navigation';

const Icon = ASSISTANT_THREAD_ICON_PRESENTATION.message.iconComponent;
const STATUS_LABEL = { idle: 'Idle', 'needs-input': 'Needs input', working: 'Working' } as const;

/**
 * BST-1932 (F19–F21): an agent host child's row: its mark, call sign, parent's
 * colour cue, unread dot and status, in the same row shape, chip and wash as
 * the thread rows above it: its family colour derives from the parent's, so
 * recolouring a thread recolours its children.
 * Clicking it opens the child's own tab in its root's workspace, opening that
 * root first, as a delegated child's row does.
 */
export function HostChildSidebarCell({
  row,
}: {
  readonly row: Extract<DelegatedSidebarRow, { kind: 'host-child' }>;
}): ReactElement {
  const { child } = row;
  if (!isAgentColor(child.color)) {
    throw new Error('The child conversation colour is not an agent colour.');
  }
  const tint = getThreadTint(child.color);
  return (
    <button
      className={`${THREAD_PANEL_ROW_CLASS_NAME} focus-visible:ring-ring w-full items-center gap-2 text-left text-xs outline-hidden focus-visible:ring-2 focus-visible:ring-inset ${tint.washClassName}`}
      data-agent-color={child.color}
      onClick={() =>
        threadWorkspaceNavigation.open(
          row.root.resourceId,
          row.root.threadId,
          hostChildWorkspaceTabId(child)
        )
      }
      style={tint.style}
      type="button"
    >
      <ThreadMarkChip color={child.color}>
        <Icon aria-hidden="true" className="size-3" />
      </ThreadMarkChip>
      <span className={THREAD_CONTROL_TITLE_CLASS_NAME} title={child.callSign}>
        {child.callSign}
      </span>
      {row.parentColor ? (
        <span
          aria-hidden="true"
          className="bs-agent-parent-cue size-2 shrink-0 rounded-full"
          style={getAgentColorStyles(row.parentColor) as CSSProperties}
          title="Parent agent color"
        />
      ) : null}
      {row.unread ? (
        <span
          aria-label="Unread child activity"
          className="bg-primary size-1.5 shrink-0 rounded-full"
          role="img"
        />
      ) : null}
      <span className="text-muted-foreground text-2xs ml-auto shrink-0 pr-1">
        {STATUS_LABEL[child.status]}
      </span>
    </button>
  );
}
