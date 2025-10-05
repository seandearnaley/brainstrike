import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SearchTab } from '../search-tab';
import { __resetSearchPanelStoreForTests, useSearchPanelStore } from '../stores/search-panel-store';

describe('SearchTab', () => {
  beforeEach(() => {
    __resetSearchPanelStoreForTests();
  });

  it('updates store state based on form interactions', async () => {
    const user = userEvent.setup();
    render(<SearchTab />);

    const queryInput = screen.getByLabelText('Query');
    await user.clear(queryInput);
    await user.type(queryInput, 'brainstrike');

    const regex = screen.getByLabelText('Regex');
    const caseSensitive = screen.getByLabelText('Case');
    const wholeWord = screen.getByLabelText('Whole word');
    await user.click(regex);
    await user.click(caseSensitive);
    await user.click(wholeWord);

    const state = useSearchPanelStore.getState();
    expect(state.query).toBe('brainstrike');
    expect(state.regex).toBe(true);
    expect(state.caseSensitive).toBe(true);
    expect(state.wholeWord).toBe(true);
  });
});
