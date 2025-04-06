const fs = require('fs');
const path = require('path');

// Files to process
const filesToFix = [
  'src/components/custom/__tests__/FileExplorer/file-explorer.file-content-loading.test.tsx',
  'src/components/custom/__tests__/FileExplorer/file-explorer.empty-states.test.tsx',
  'src/components/custom/__tests__/FileExplorer/file-explorer.test.tsx',
  'src/components/custom/__tests__/FileExplorer/file-explorer.state-persistence.test.tsx',
  'src/hooks/__tests__/use-file-content-loading.test.ts',
  'src/hooks/__tests__/use-quick-filter.test.tsx',
  'src/hooks/__tests__/use-undoable-action.test.ts',
  'src/hooks/__tests__/use-debounced-value.test.tsx',
  'src/hooks/__tests__/use-file-tree.test.ts',
  'src/hooks/__tests__/use-file-explorer.test.ts',
  'src/hooks/__tests__/use-file-system.test.ts'
];

// Process each file
filesToFix.forEach(filePath => {
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace incorrect import patterns
  const updatedContent = content.replace(/use--/g, 'use-');
  
  if (content !== updatedContent) {
    fs.writeFileSync(filePath, updatedContent);
    console.log(`Updated imports in: ${filePath}`);
  } else {
    console.log(`No changes needed in: ${filePath}`);
  }
});

// Also fix the store import in any file that might be using it
const storeImportFiles = [
  'src/hooks/__tests__/use-file-system.test.ts',
  'src/components/custom/__tests__/action-buttons.test.tsx',
  'src/components/custom/__tests__/FileExplorer/file-explorer-config.test.tsx',
  'src/components/custom/__tests__/file-tree.test.tsx',
  'src/components/custom/__tests__/file-tree-node.test.tsx',
  'src/stores/__tests__/useFileExplorerStore.folderStateManagement.test.ts',
  'src/stores/__tests__/useFileExplorerStore.test.ts'
];

storeImportFiles.forEach(filePath => {
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace incorrect store import
  const updatedContent = content.replace(
    /from ['"]@\/stores\/useFileExplorerStore['"]/g, 
    'from \'@/stores/use-file-explorer-store\''
  );
  
  if (content !== updatedContent) {
    fs.writeFileSync(filePath, updatedContent);
    console.log(`Updated store import in: ${filePath}`);
  } else {
    console.log(`No store import changes needed in: ${filePath}`);
  }
});

console.log('Import fixes completed!'); 