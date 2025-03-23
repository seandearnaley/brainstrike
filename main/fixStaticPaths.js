const fs = require('fs');
const path = require('path');

/**
 * Fixes path references in the Next.js static export files
 * to work properly with Electron's file:// protocol
 */
function fixStaticPaths() {
  const outputDir = path.join(__dirname, '../next-app/out');
  const indexHtmlPath = path.join(outputDir, 'index.html');
  
  console.log('Fixing static paths for Electron...');
  
  // Check if index.html exists
  if (!fs.existsSync(indexHtmlPath)) {
    console.error(`Error: ${indexHtmlPath} not found. Make sure to build the Next.js app first.`);
    return false;
  }
  
  try {
    // Read the HTML file
    let htmlContent = fs.readFileSync(indexHtmlPath, 'utf8');
    
    // Get the absolute path to the _next directory
    const nextDirAbsolute = path.resolve(__dirname, '../next-app/out/_next');
    
    // Replace all /_next/ references with absolute file:// paths
    htmlContent = htmlContent.replace(/\"\/_next\//g, `"file://${nextDirAbsolute}/`);
    
    // Fix relative paths to other pages with absolute paths
    const appDirAbsolute = path.resolve(__dirname, '../next-app/out');
    htmlContent = htmlContent.replace(/href="\/([^"]+)"/g, (match, p1) => {
      return `href="file://${appDirAbsolute}/${p1}"`;
    });
    
    // Write the modified content back
    fs.writeFileSync(indexHtmlPath, htmlContent);
    
    // Do the same for other HTML files
    const htmlFiles = ['404.html', 'settings.html'];
    htmlFiles.forEach(file => {
      const filePath = path.join(outputDir, file);
      if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf8');
        content = content.replace(/\"\/_next\//g, `"file://${nextDirAbsolute}/`);
        content = content.replace(/href="\/([^"]+)"/g, (match, p1) => {
          return `href="file://${appDirAbsolute}/${p1}"`;
        });
        fs.writeFileSync(filePath, content);
      }
    });
    
    // Also fix any JSON files that might contain paths
    const dataPath = path.join(outputDir, '_next', 'data');
    if (fs.existsSync(dataPath)) {
      const jsonFiles = fs.readdirSync(dataPath);
      jsonFiles.forEach(file => {
        if (file.endsWith('.json')) {
          const filePath = path.join(dataPath, file);
          try {
            let content = fs.readFileSync(filePath, 'utf8');
            content = content.replace(/\"\/_next\//g, `"file://${nextDirAbsolute}/`);
            fs.writeFileSync(filePath, content);
          } catch (err) {
            console.warn(`Warning: Could not process JSON file ${file}`, err);
          }
        }
      });
    } else {
      console.log(`No '_next/data' directory found - skipping JSON file processing`);
    }
    
    console.log('Static paths fixed successfully!');
    return true;
  } catch (error) {
    console.error('Error fixing static paths:', error);
    return false;
  }
}

module.exports = { fixStaticPaths };