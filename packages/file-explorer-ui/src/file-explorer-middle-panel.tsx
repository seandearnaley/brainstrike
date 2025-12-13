import { estimateTokenCost } from '@brainstrike/utils';
import { FileExplorerMiddlePanelBase } from './file-explorer-middle-panel-base';

/**
 * FileExplorerMiddlePanel - Contains the preview panel and action buttons
 * This component can be used independently in the middle panel of an IDE layout
 */
export const FileExplorerMiddlePanel: React.FC = () => (
  <FileExplorerMiddlePanelBase estimateTokenCost={estimateTokenCost} />
);

FileExplorerMiddlePanel.displayName = 'FileExplorerMiddlePanel';
