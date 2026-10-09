import { getAgentColorStyles, isAgentColor } from '@brainstrike/types/agent-color';
import type { CSSProperties, ReactElement } from 'react';
import { getDelegatedColorPresentation } from './agent-color-presentation';
import { ASSISTANT_THREAD_ICON_PRESENTATION } from './assistant-thread-presentation';
import type { DelegatedSidebarRow } from './delegated-sidebar-rows';
import { openHostChildTab } from './open-host-child-tab';

const Icon = ASSISTANT_THREAD_ICON_PRESENTATION.message.iconComponent;
const STATUS_LABEL = { idle: 'Child', 'needs-input': 'Needs input', working: 'Working' } as const;

/**
 * BST-1932 (F19–F21): an agent host child's row: its mark, call sign, parent's
 * colour cue, unread dot and status, as the shipped child rows show them.
 * Clicking it opens the child's own tab.
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
  const appearance = getDelegatedColorPresentation(child.color);
  return (
    <button
      className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left text-xs ${appearance.idleClassName}`}
      data-agent-color={child.color}
      onClick={() => openHostChildTab(child)}
      style={appearance.style}
      type="button"
    >
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-md border ${appearance.markClassName}`}
      >
        <Icon aria-hidden="true" className="size-3.5" />
      </span>
      <span className="truncate">{child.callSign}</span>
      {row.parentColor ? (
        <span
          aria-hidden="true"
          className="bs-agent-parent-cue size-2 shrink-0 rounded-full"
          style={getAgentColorStyles(row.parentColor) as CSSProperties}
          title="Parent agent color"
        />
      ) : null}
      {row.unread ? (
        <span aria-label="Unread child activity" className="shrink-0 text-xs" role="img">
          •
        </span>
      ) : null}
      <span className="ml-auto shrink-0 text-muted-foreground">{STATUS_LABEL[child.status]}</span>
    </button>
  );
}
