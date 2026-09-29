import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ControlsMenu } from '../assistant-controls-menu';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
} from '../assistant-detail-level-context';

async function setup(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(
    <AssistantDetailLevelProvider>
      <ControlsMenu />
    </AssistantDetailLevelProvider>
  );
  await user.click(screen.getByRole('button', { name: 'Open assistant controls' }));
  return user;
}

describe('DetailLevelControl (real browser)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  test('lists all three levels with standard active by default', async () => {
    await setup();
    expect(screen.getByRole('radio', { name: /Compact/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Developer/ })).toBeInTheDocument();
  });

  test('selecting Developer persists the choice and keeps Controls open', async () => {
    const user = await setup();

    await user.click(screen.getByRole('radio', { name: /Developer/ }));

    expect(window.localStorage.getItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY)).toBe('developer');
    expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Developer/ })).toBeChecked();
  });

  test('arrow keys move between detail levels and persist the selection', async () => {
    const user = await setup();
    const standard = screen.getByRole('radio', { name: /Standard/ });
    standard.focus();

    await user.keyboard('{ArrowRight}');

    expect(screen.getByRole('radio', { name: /Developer/ })).toBeChecked();
    expect(window.localStorage.getItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY)).toBe('developer');
    expect(screen.getByRole('dialog', { name: 'Assistant controls' })).toBeInTheDocument();
  });
});
