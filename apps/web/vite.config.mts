import path from "node:path";
import { fileURLToPath } from "node:url";
/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { existsSync } from "node:fs";
import { codecovVitePlugin } from "@codecov/vite-plugin";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { viteStaticCopy } from "vite-plugin-static-copy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Find the PGLite WASM file in different possible locations
function findPGliteWasm(): string | null {
  const possiblePaths = [
    path.resolve(__dirname, '../../node_modules/@electric-sql/pglite/dist/pglite.wasm'),
    path.resolve(__dirname, 'node_modules/@electric-sql/pglite/dist/pglite.wasm'),
  ];
  
  // Also try to find in pnpm directory structure with any version
  try {
    const pnpmDir = path.resolve(__dirname, '../../node_modules/.pnpm');
    if (existsSync(pnpmDir)) {
      const entries = readdirSync(pnpmDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('@electric-sql+pglite@')) {
          const wasmPath = path.join(pnpmDir, entry.name, 'node_modules/@electric-sql/pglite/dist/pglite.wasm');
          possiblePaths.push(wasmPath);
        }
      }
    }
  } catch (err) {
    // Ignore errors when scanning pnpm directory
  }
  
  for (const wasmPath of possiblePaths) {
    if (existsSync(wasmPath)) {
      console.log(`Found PGLite WASM at: ${wasmPath}`);
      return wasmPath;
    }
  }
  
  console.warn('PGLite WASM file not found in any expected location');
  return null;
}

function debugPlugin() {
  return {
    name: 'debug-build-context',
    buildStart() {
      console.log('=== DEBUG PLUGIN BUILDSTART ===');
      console.log('Build starting, CWD:', process.cwd());
      console.log('Vercel env:', process.env.VERCEL);
      console.log('=== END DEBUG PLUGIN ===');
    }
  };
}

function copyFontsPlugin() {
  return {
    name: 'copy-fonts',
    buildStart() {
      // Copy fonts from the fonts package to public and dist directories
      const fontsPackagePath = path.resolve(__dirname, '../../packages/fonts/src/inter');
      const publicFontsPath = path.resolve(__dirname, 'public/fonts/inter');
      const distFontsPath = path.resolve(__dirname, 'dist/fonts/inter');
      
      // Create the public fonts directory if it doesn't exist
      if (!existsSync(path.resolve(__dirname, 'public/fonts'))) {
        mkdirSync(path.resolve(__dirname, 'public/fonts'), { recursive: true });
      }
      if (!existsSync(publicFontsPath)) {
        mkdirSync(publicFontsPath, { recursive: true });
      }
      if (!existsSync(distFontsPath)) {
        mkdirSync(distFontsPath, { recursive: true });
      }
      
      // Copy font files
      const fontFiles = ['InterVariable.ttf', 'InterVariable-Italic.ttf'];
      fontFiles.forEach(file => {
        const src = path.join(fontsPackagePath, file);
        const destPublic = path.join(publicFontsPath, file);
        const destDist = path.join(distFontsPath, file);
        if (existsSync(src)) {
          copyFileSync(src, destPublic);
          copyFileSync(src, destDist);
          console.log(`Copied font: ${file}`);
        }
      });
    }
  };
}

const wasmPath = findPGliteWasm();

// CRITICAL DEBUG: Force console output to appear in logs - CACHE BUST v2
console.log('=== VITE CONFIG DEBUG START (FORCE DEPLOY v2) ===');
console.log('Current working directory:', process.cwd());
console.log('__dirname:', __dirname);
console.log('process.env.VERCEL:', process.env.VERCEL);
console.log('process.env.CI:', process.env.CI);

// Always use relative paths since Vercel still builds from apps/web directory
// but provide explicit content array to ensure monorepo packages are included
const tailwindConfigContent = [
  './index.html',
  './src/**/*.{js,ts,jsx,tsx}',
  // Package source files
  '../../packages/ui/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/app-shell/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-ui/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-hooks/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/hooks/src/**/*.{js,ts,jsx,tsx}',
  // Package built files (in case they're used)
  '../../packages/ui/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/app-shell/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-ui/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/file-explorer-hooks/dist/**/*.{js,ts,jsx,tsx}',
  '../../packages/hooks/dist/**/*.{js,ts,jsx,tsx}',
  // Additional packages that might have UI components
  '../../packages/*/src/**/*.{js,ts,jsx,tsx}',
  '../../packages/*/dist/**/*.{js,ts,jsx,tsx}',
];

console.log('Tailwind content paths:', tailwindConfigContent);

// Verify that key packages exist and log their status
const keyPackages = [
  '../../packages/ui/src',
  '../../packages/app-shell/src',
  '../../packages/file-explorer-ui/src'
];

keyPackages.forEach(pkg => {
  const pkgPath = path.resolve(__dirname, pkg);
  console.log(`Package path ${pkg}: exists=${existsSync(pkgPath)}, resolved=${pkgPath}`);
});

console.log('=== VITE CONFIG DEBUG END ===');

export default defineConfig({
  cacheDir: path.resolve(__dirname, '../../.vite'),
  server: {
    port: 8080,
    host: true,
  },
  define: {
    'process.env': {},
    'process.browser': true,
    'process.version': '"v16.0.0"',
    'process.platform': '"browser"',
  },
  plugins: [
    debugPlugin(),
    wasm(),
    topLevelAwait(),
    react(),
    tailwindcss({
      content: tailwindConfigContent,
    }),
    copyFontsPlugin(),
    ...(wasmPath ? [
      viteStaticCopy({
        targets: [
          {
            src: wasmPath,
            dest: 'assets',
          },
        ],
      })
    ] : []),
    // Conditionally configure Codecov plugin
    ...(process.env['CODECOV_TOKEN']
      ? [
          codecovVitePlugin({
            enableBundleAnalysis: true,
            bundleName: "brainstrike-web-bundle",
            uploadToken: process.env['CODECOV_TOKEN'],
          }),
        ]
      : []), // If no token, don't include the plugin config
  ],
  assetsInclude: ['**/*.png'],
  build: {
    minify: "terser", // Use terser for better minification
    terserOptions: {
      compress: { drop_console: false },
    },
    outDir: "dist", // Output directory for the build
    assetsDir: "assets", // Directory for static assets within the build output
    sourcemap: false, // Disable sourcemaps for production build
    target: 'es2020',
    assetsInlineLimit: 0,
    rollupOptions: {
      external: ['electron'],
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules")) {
            // Group vendor dependencies
            return "vendor";
          }
          // Explicitly return undefined for other modules to keep them in the default chunk
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      src: path.resolve(__dirname, "./src"),
      '@brainstrike/file-explorer': path.resolve(__dirname, '../../packages/file-explorer/src'),
      '@brainstrike/db': path.resolve(__dirname, '../../packages/db/src/index.ts'),
    },
  },  
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: [
      '@electric-sql/pglite', // Official PGlite requirement
      '@brainstrike/types',
      '@brainstrike/hooks',
      '@brainstrike/ui',
      '@brainstrike/utils',
      '@brainstrike/file-explorer',
      '@brainstrike/file-explorer-hooks',
      '@brainstrike/file-explorer-ui',
      '@brainstrike/file-system',
      '@brainstrike/storage',
      '@brainstrike/app-shell'
    ],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    setupFiles: ["@brainstrike/test-utils/vitest.setup"],
    include: [
      "src/**/__tests__/**/*.test.{ts,tsx}",
      "src/**/__tests__/**/*.spec.{ts,tsx}",
      "src/**/*.test.{ts,tsx}",
      "src/**/*.spec.{ts,tsx}",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/e2e/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    reporters: ["default", "hanging-process"],
    silent: true,
    onConsoleLog: (log, type) => {
      if (
        type === "stderr" &&
        log.includes("ERROR") &&
        !log.includes("Error: Not implemented")
      ) {
        return true;
      }
      return false;
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      exclude: [
        "coverage/**",
        "dist/**",
        "**/[.]**",
        "packages/*/test{,s}/**",
        "**/*.d.ts",
        "cypress/**",
        "test{,s}/**",
        "test{,-*}.{js,cjs,mjs,ts,tsx,jsx}",
        "**/*{.,-}test.{js,cjs,mjs,ts,tsx,jsx}",
        "**/*{.,-}spec.{js,cjs,mjs,ts,tsx,jsx}",
        "**/__tests__/**",
        "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress}.config.*",
        "**/.{eslint,mocha,prettier}rc.{js,cjs,yml}",
      ],
      all: true,
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
    mockReset: true,
    deps: {
      inline: [
        '@brainstrike/types',
        '@brainstrike/hooks',
        '@brainstrike/ui',
        '@brainstrike/utils'
      ],
    },
  },
});
