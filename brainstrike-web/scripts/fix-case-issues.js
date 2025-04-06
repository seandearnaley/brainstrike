const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Find all test files
const testFiles = execSync('find src -type f -name "*.test.ts*"', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

// Process each file
testFiles.forEach(filePath => {
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  let updated = false;
  
  // Fix case issues in hook imports
  if (content.includes('use-FileSystem') || content.includes('use-FileExplorer') || 
      content.includes('use-FileTree') || content.includes('use-FileFilters') || 
      content.includes('use-FileContentLoading') || content.includes('use-QuickFilter') ||
      content.includes('use-FileExplorerSettings')) {
    
    content = content.replace(/use-FileSystem/g, 'use-file-system');
    content = content.replace(/use-FileExplorer/g, 'use-file-explorer');
    content = content.replace(/use-FileTree/g, 'use-file-tree');
    content = content.replace(/use-FileFilters/g, 'use-file-filters');
    content = content.replace(/use-FileContentLoading/g, 'use-file-content-loading');
    content = content.replace(/use-QuickFilter/g, 'use-quick-filter');
    content = content.replace(/use-FileExplorerSettings/g, 'use-file-explorer-settings');
    
    updated = true;
  }
  
  // Fix testUtils import
  if (content.includes('test/testUtils')) {
    content = content.replace(/test\/testUtils/g, 'test/test-utils');
    updated = true;
  }
  
  // Fix file-node import
  if (content.includes('test/factories/fileNode')) {
    content = content.replace(/test\/factories\/fileNode/g, 'test/factories/file-node');
    updated = true;
  }
  
  if (updated) {
    fs.writeFileSync(filePath, content);
    console.log(`Updated case issues in: ${filePath}`);
  }
});

// Fix component files
const componentFiles = [
  'src/components/custom/file-tree.tsx',
  'src/components/custom/file-tree-node.tsx',
  'src/hooks/use-file-system.ts',
  'src/app/page.tsx',
  'src/app/settings/page.tsx'
];

componentFiles.forEach(filePath => {
  if (!fs.existsSync(filePath)) {
    console.log(`File not found: ${filePath}`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  let updated = false;
  
  // Fix store import
  if (content.includes('useFileExplorerStore')) {
    content = content.replace(/from ['"]@\/stores\/useFileExplorerStore['"]/g, 'from \'@/stores/use-file-explorer-store\'');
    content = content.replace(/from ['"]\.\.\/stores\/useFileExplorerStore['"]/g, 'from \'../stores/use-file-explorer-store\'');
    updated = true;
  }
  
  // Fix ClientFileExplorer import
  if (content.includes('ClientFileExplorer')) {
    content = content.replace(/from ['"]\.\.\/components\/custom\/ClientFileExplorer['"]/g, 'from \'../components/custom/client-file-explorer\'');
    updated = true;
  }
  
  // Fix ThemeSettings import
  if (content.includes('ThemeSettings')) {
    content = content.replace(/from ['"]\.\.\/\.\.\/components\/custom\/Settings\/ThemeSettings['"]/g, 'from \'../../components/custom/Settings/theme-settings\'');
    updated = true;
  }
  
  if (updated) {
    fs.writeFileSync(filePath, content);
    console.log(`Updated imports in component: ${filePath}`);
  }
});

console.log('Case issues fixes completed!'); 