import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SearchTab } from '../search-tab';
import { __resetSearchPanelStoreForTests, useSearchPanelStore } from '../stores/search-panel-store';

describe('SearchTab', () => {
  beforeEach(() => {
    __resetSearchPanelStoreForTests();
  });

  it('updates store state based on form interactions', async () => {
    render(<SearchTab />);

    const queryInput = screen.getByLabelText('Query');
    fireEvent.change(queryInput, { target: { value: '' } });
    fireEvent.change(queryInput, { target: { value: 'brainstrike' } });

    const regex = screen.getByLabelText('Regex');
    const caseSensitive = screen.getByLabelText('Case');
    const wholeWord = screen.getByLabelText('Whole word');
    fireEvent.click(regex);
    fireEvent.click(caseSensitive);
    fireEvent.click(wholeWord);

    const state = useSearchPanelStore.getState();
    expect(state.query).toBe('brainstrike');
    expect(state.regex).toBe(true);
    expect(state.caseSensitive).toBe(true);
    expect(state.wholeWord).toBe(true);
  });
});
