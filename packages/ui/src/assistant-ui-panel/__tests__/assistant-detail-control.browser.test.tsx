import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DropdownMenu, DropdownMenuContent } from '../../dropdown-menu';
import { DetailLevelControl } from '../assistant-detail-control';
import {
  ASSISTANT_DETAIL_LEVEL_STORAGE_KEY,
  AssistantDetailLevelProvider,
} from '../assistant-detail-level-context';

function setup() {
  return render(
    <AssistantDetailLevelProvider>
      <DropdownMenu defaultOpen>
        <DropdownMenuContent>
          <DetailLevelControl />
        </DropdownMenuContent>
      </DropdownMenu>
    </AssistantDetailLevelProvider>
  );
}

describe('DetailLevelControl (real browser)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => window.localStorage.clear());

  test('lists all three levels with standard active by default', () => {
    setup();
    expect(screen.getByRole('menuitemradio', { name: /Compact/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Standard/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('menuitemradio', { name: /Developer/ })).toBeInTheDocument();
  });

  test('selecting Developer persists the choice and keeps the menu open', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('menuitemradio', { name: /Developer/ }));

    expect(window.localStorage.getItem(ASSISTANT_DETAIL_LEVEL_STORAGE_KEY)).toBe('developer');
    // Menu stays open so the new active state is visible.
    expect(screen.getByRole('menuitemradio', { name: /Developer/ })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });
});
