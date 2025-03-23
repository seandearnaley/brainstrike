const express = require('express');
const path = require('path');
const fs = require('fs');

function createServer() {
  const app = express();
  const port = 3000;
  const outDir = path.join(__dirname, '../next-app/out');
  
  // Set up CORS to allow any origin
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  });

  // Log all requests for debugging
  app.use((req, res, next) => {
    console.log(`Request: ${req.method} ${req.url}`);
    next();
  });
  
  // Serve static files from Next.js output with correct MIME types
  app.use('/_next', express.static(path.join(outDir, '_next'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript');
      if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css');
      if (filePath.endsWith('.woff2')) res.setHeader('Content-Type', 'font/woff2');
    }
  }));
  
  // Serve other static files
  app.use(express.static(outDir));
  
  // Handle all routes - direct them to index.html
  app.get('*', (req, res) => {
    console.log(`Fallback for: ${req.url}`);
    res.sendFile(path.join(outDir, 'index.html'));
  });
  
  // Start the server
  const server = app.listen(port, () => {
    console.log(`Next.js app server running at http://localhost:${port}`);
  });
  
  return {
    port,
    close: () => server.close()
  };
}

module.exports = { createServer };