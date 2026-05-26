# @brainstrike/file-explorer-hooks

This package contains React hooks for the file explorer feature, designed to be reused across different front-ends.

## Available Hooks

- `useFileSystem`: Provides core file system access functionalities, including selecting a root directory and checking API compatibility.
- `useSelectionManager`: Manages file and directory selection state, including selection limits.
- `useToastManager`: Provides helper functions for displaying file-explorer related toasts.

## Installation

This package is internal to the `@brainstrike` monorepo and is typically consumed via workspace linking.

## Usage

```tsx
import { useFileSystem, useSelectionManager } from '@brainstrike/file-explorer-hooks';
import { useFileExplorerStore } from '@brainstrike/file-explorer'; // Assuming the store is also used

function MyFileExplorerComponent() {
  const { rootDirectoryHandle, selectRootDirectory, isFileSystemAccessSupported } = useFileSystem();
  const { selectedFilePaths, handleSelectionChange } = useSelectionManager();
  const { maxSelectionCount } = useFileExplorerStore(); // Example from store

  // ... component logic ...

  return (
    <div>
      <button onClick={selectRootDirectory} disabled={!isFileSystemAccessSupported().supported}>
        Select Root Folder
      </button>
      <p>Selected {selectedFilePaths.size} of {maxSelectionCount} files.</p>
      {/* ... other UI elements ... */}
    </div>
  );
}
``` 
