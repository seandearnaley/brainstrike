const express = require('express');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');

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
      // Set appropriate content types based on file extension
      const contentType = mime.lookup(filePath);
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
      // Set caching headers
      res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year
    }
  }));
  
  // Serve other static assets (icons, etc.)
  app.use(express.static(outDir, {
    setHeaders: (res, filePath) => {
      const contentType = mime.lookup(filePath);
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }
    }
  }));
  
  // Special handling for .txt files (RSC payloads)
  app.get('/*.txt', (req, res) => {
    const filePath = path.join(outDir, req.path);
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).send('Not found');
    }
  });

  // Handle all routes - direct them to index.html for client-side routing
  app.get('*', (req, res) => {
    console.log(`Serving index.html for: ${req.url}`);
    res.sendFile(path.join(outDir, 'index.html'));
  });
  
  // Start the server
  const server = app.listen(port, () => {
    console.log(`Next.js app server running at http://localhost:${port}`);
  });
  
  return {
    port,
    close: () => {
      console.log('Closing server...');
      server.close();
    }
  };
}

module.exports = { createServer };