import type { ReactElement } from 'react';
import { FileExplorerMiddlePanelBase } from './file-explorer-middle-panel-base';

/**
 * The Files (context-explorer) workspace app body: the explorer's middle panel
 * (collection browser / preview surface). Exported so the host apps can render
 * it as the `contextExplorerPageContent` inside the nested explorer layout —
 * the workspace tab strip itself now lives in the outer panel header
 * (BST-1258), so this surface no longer hosts tabs of its own.
 */
export function ContextExplorerAppBody(): ReactElement {
  return <FileExplorerMiddlePanelBase />;
}
