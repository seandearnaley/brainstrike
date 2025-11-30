import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { FileTab } from '../hooks/use-tab-manager';
import { useEditorViewStateStore } from '../stores/editor-view-state-store';
import { TabbedFileEditor } from '../tabbed-file-editor';

function decode(compositeKey: string) {
  return { folderId: compositeKey.split(':')[0] ?? 'root', path: compositeKey };
}

describe('TabbedFileEditor view-state integration', () => {
  it('restores scrollTop for active tab content from store', async () => {
    const tabs: FileTab[] = [
      {
        id: 't1',
        path: '/a',
        compositeKey: 'root:/a',
        content: 'line1\nline2\nline3\nline4\nline5\n'.repeat(20),
        isLoading: false,
      },
    ];
    const fileContents = { 'root:/a': tabs[0]?.content as string };
    const loadingFiles = new Set<string>();

    // seed store with scroll position
    useEditorViewStateStore.getState().setScrollTop('root:/a', 200);

    render(
      <TabbedFileEditor
        activeTabId="t1"
        decodeFileSelection={decode}
        fileContents={fileContents}
        loadingFiles={loadingFiles}
        onLoadFileContent={() => {}}
        onTabClick={() => {}}
        onTabClose={() => {}}
        tabs={tabs}
      />
    );

    const pre = await screen.findByRole('tabpanel');
    const scroller = pre.querySelector('pre') as HTMLPreElement;
    expect(scroller).toBeTruthy();
    // Expect the component to restore scrollTop to stored value
    expect(scroller.scrollTop).toBe(200);

    // Simulate user scroll and ensure value is persisted back
    scroller.scrollTop = 300;
    fireEvent.scroll(scroller, { target: { scrollTop: 300 } });
    expect(useEditorViewStateStore.getState().getScrollTop('root:/a')).toBe(300);
  });
});
