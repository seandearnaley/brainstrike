import { estimateTokenCost } from '@brainstrike/text-splitter';
import { FileExplorerMiddlePanelBase } from './file-explorer-middle-panel-base';

/**
 * FileExplorerMiddlePanel - Contains the context explorer panel and action controls
 * This component can be used independently in the middle panel of an IDE layout
 */
export const FileExplorerMiddlePanel: React.FC = () => (
  <FileExplorerMiddlePanelBase estimateTokenCost={estimateTokenCost} />
);

FileExplorerMiddlePanel.displayName = 'FileExplorerMiddlePanel';
