import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ControlsMenu } from '../assistant-controls-menu';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  useAssistantDetailLevelStore,
} from '../assistant-detail-level-store.ts';

/** The Detail level the next launch reads back. */
function savedDetailLevel(): unknown {
  const saved = window.localStorage.getItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY);
  return saved === null
    ? null
    : (JSON.parse(saved) as { state: { detailLevel: unknown } }).state.detailLevel;
}

function resetDetailLevel(): void {
  useAssistantDetailLevelStore.setState(useAssistantDetailLevelStore.getInitialState(), true);
  window.localStorage.clear();
}

async function setup(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<ControlsMenu />);
  await user.click(screen.getByRole('button', { name: 'Open assistant controls' }));
  return user;
}

describe('DetailLevelControl (real browser)', () => {
  beforeEach(resetDetailLevel);
  afterEach(resetDetailLevel);

  test('lists all three levels with standard active by default', async () => {
    await setup();
    expect(screen.getByRole('radio', { name: /Compact/u })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Standard/u })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Developer/u })).toBeInTheDocument();
  });

  test('selecting Developer persists the choice and keeps Controls open', async () => {
    const user = await setup();

    await user.click(screen.getByRole('radio', { name: /Developer/u }));

    expect(savedDetailLevel()).toBe('developer');
    expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Developer/u })).toBeChecked();
  });

  test('arrow keys move between detail levels and persist the selection', async () => {
    const user = await setup();
    const standard = screen.getByRole('radio', { name: /Standard/u });
    standard.focus();

    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('radio', { name: /Developer/u })).toBeChecked();
    expect(savedDetailLevel()).toBe('developer');
    expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();
  });
});
