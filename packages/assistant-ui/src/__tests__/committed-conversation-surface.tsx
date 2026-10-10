import { TooltipProvider } from '@brainstrike/ui';
import { screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { CommittedAssistantConversation } from '../committed-assistant-conversation';
import type {
  CommittedAssistantCommands,
  CommittedAssistantStore,
} from '../committed-assistant-store';

const LABEL = 'Committed conversation';

export function Surface({
  store,
  actions,
  width = 900,
  height = 620,
  label = LABEL,
}: {
  readonly store: CommittedAssistantStore;
  readonly actions: CommittedAssistantCommands;
  readonly width?: number;
  readonly height?: number;
  readonly label?: string;
}): ReactElement {
  return (
    <TooltipProvider>
      <div style={{ height, width }}>
        <CommittedAssistantConversation commands={actions} label={label} store={store} />
      </div>
    </TooltipProvider>
  );
}

/** The shipped region plus the committed wrapper that also hosts owner status and alerts. */
export function conversation(label = LABEL) {
  const region = screen.getByRole('region', { name: label });
  const root = region.parentElement;
  if (!root) {
    throw new Error('The committed conversation wrapper is missing.');
  }
  const ui = within(region);
  return {
    host: within(root),
    input: ui.getByRole('textbox', { name: 'Message input' }),
    region,
    root,
    ui,
    viewport: ui.getByTestId('assistant-ui-viewport'),
  };
}
