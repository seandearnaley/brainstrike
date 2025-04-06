const fs = require('fs');
const path = require('path');

// Function to convert @/ path to relative path
function convertToRelativePath(importPath, filePath) {
  // Get the directory name of the current file
  const fileDir = path.dirname(filePath);
  
  // Remove the @/ prefix
  const targetPath = importPath.replace('@/', '');
  
  // Calculate the relative path from the current file to the target
  const relativePath = path.relative(fileDir, targetPath);
  
  // Ensure the path starts with ./ or ../
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

// Function to process a file and fix all @/ imports
function processFile(filePath) {
  console.log(`Processing: ${filePath}`);
  
  try {
    // Read the file content
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Regular expression to match import statements with @/ paths
    const importRegex = /(import\s+(?:{[^}]*}|\*\s+as\s+[^;]+|[^;{]+)\s+from\s+['"])(@\/[^'"]+)(['"];)/g;
    
    // Replace all @/ imports with relative paths
    const updatedContent = content.replace(importRegex, (match, prefix, importPath, suffix) => {
      const relativePath = convertToRelativePath(importPath, filePath);
      return `${prefix}${relativePath}${suffix}`;
    });
    
    // Check if there were any changes
    if (content !== updatedContent) {
      // Write the updated content back to the file
      fs.writeFileSync(filePath, updatedContent);
      console.log(`Updated imports in: ${filePath}`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error(`Error processing file ${filePath}:`, error);
    return false;
  }
}

// Recursively process all TypeScript and TSX files in a directory
function processDirectory(dirPath) {
  let changedFiles = 0;
  
  const items = fs.readdirSync(dirPath);
  
  for (const item of items) {
    const itemPath = path.join(dirPath, item);
    const stat = fs.statSync(itemPath);
    
    if (stat.isDirectory()) {
      // Process subdirectories recursively
      changedFiles += processDirectory(itemPath);
    } else if ((itemPath.endsWith('.ts') || itemPath.endsWith('.tsx')) && 
               !itemPath.includes('node_modules')) {
      // Process TypeScript and TSX files
      if (processFile(itemPath)) {
        changedFiles++;
      }
    }
  }
  
  return changedFiles;
}

// Start processing from the src directory
const srcDir = path.join(__dirname, 'src');
console.log(`Starting to process files in: ${srcDir}`);
const changedFiles = processDirectory(srcDir);
console.log(`Finished processing. Updated ${changedFiles} files.`); 