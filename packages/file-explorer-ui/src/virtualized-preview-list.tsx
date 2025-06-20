import { memo } from 'react';
import FileRow from './file-row';
import FolderHeaderRow from './folder-header-row';
import type { ListItem } from './use-preview-panel-state';
import type { UsePreviewPanelStateReturn } from './use-preview-panel-state';

interface VirtualizedPreviewListProps {
  state: UsePreviewPanelStateReturn;
  onFileClick: (compositeKey: string) => void;
}

export const VirtualizedPreviewList = memo<VirtualizedPreviewListProps>(
  function VirtualizedPreviewList({ state, onFileClick }) {
    const {
      flatListItems,
      scrollElementRef,
      virtualizer,
      collapsedFolders,
      batchSelectedFiles,
      toggleFolderCollapse,
      toggleFileSelection,
      handleRemoveFile,
      formatFileSize,
      loadingFiles,
    } = state;

    return (
      <div
        ref={scrollElementRef}
        className="h-full w-full overflow-auto"
        aria-label="File preview panel"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = flatListItems[virtualItem.index] as ListItem | undefined;
            if (!item) return null;

            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualItem.size}px`,
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                {item.type === 'folder-header' ? (
                  <FolderHeaderRow
                    item={item}
                    isCollapsed={collapsedFolders.has(item.folderId)}
                    onToggleCollapse={() => toggleFolderCollapse(item.folderId)}
                  />
                ) : (
                  <FileRow
                    item={item}
                    isSelected={batchSelectedFiles.has(item.compositeKey)}
                    isLoading={loadingFiles.has(item.compositeKey)}
                    onToggleSelection={(checked) => toggleFileSelection(item.compositeKey, checked)}
                    onRemove={() => handleRemoveFile(item.compositeKey)}
                    onShowDetail={() => onFileClick(item.compositeKey)}
                    formatFileSize={formatFileSize}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }
);

VirtualizedPreviewList.displayName = 'VirtualizedPreviewList';
