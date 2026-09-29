import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useDocumentTitle } from '../use-document-title';

function TitleWriter(): null {
  useDocumentTitle();
  return null;
}

function readTitles(): string[] {
  return Array.from(document.head.querySelectorAll('title'), (node) => node.textContent ?? '');
}

function readDescriptions(): string[] {
  return Array.from(
    document.head.querySelectorAll<HTMLMetaElement>('meta[name="description"]'),
    (node) => node.content
  );
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    act(() => {
      usePanelLayoutStore.setState({ activeTab: 'explorer' });
    });
  });

  afterEach(() => {
    for (const node of document.head.querySelectorAll('title, meta[name="description"]')) {
      node.remove();
    }
  });

  test('writes the active tab title and description', () => {
    render(<TitleWriter />);

    expect(readTitles()).toEqual(['BrainStrike.ai - Home']);
    expect(readDescriptions()).toEqual(['BrainStrike.ai Home Dashboard']);
  });

  test('follows the active tab across route switches', () => {
    render(<TitleWriter />);

    act(() => {
      usePanelLayoutStore.getState().setActiveTab('git');
    });
    expect(document.title).toBe('Git - BrainStrike.ai');

    act(() => {
      usePanelLayoutStore.getState().setActiveTab('terminal');
    });
    expect(document.title).toBe('Terminal - BrainStrike.ai');
  });

  test('follows the settings route like any other tab (BST-1668)', () => {
    // Settings is a shell route, so `openSettings` and `setActiveTab` are the
    // same transition and the title tracks `activeTab` alone.
    render(<TitleWriter />);

    act(() => {
      usePanelLayoutStore.getState().openSettings();
    });
    expect(readTitles()).toEqual(['Settings - BrainStrike.ai']);
    expect(readDescriptions()).toEqual(['Customize your application settings']);

    act(() => {
      usePanelLayoutStore.getState().setActiveTab('explorer');
    });
    expect(readTitles()).toEqual(['BrainStrike.ai - Home']);
  });

  test('never accumulates a second title or description element', () => {
    // The failure mode this hook exists to make impossible: `root-layout-content.tsx`
    // keeps every visited tab mounted, so a per-surface writer multiplies the tags.
    // Even mounted twice, the hook mutates the same two nodes.
    render(
      <>
        <TitleWriter />
        <TitleWriter />
      </>
    );

    act(() => {
      usePanelLayoutStore.getState().setActiveTab('notes');
    });

    expect(readTitles()).toEqual(['Notes - BrainStrike.ai']);
    expect(readDescriptions()).toEqual(['Multi-app dashboard']);
  });
});
