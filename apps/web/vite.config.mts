import path from "node:path";
import { fileURLToPath } from "node:url";
/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
// import { nodePolyfills } from "vite-plugin-node-polyfills"; // Removed
import { codecovVitePlugin } from "@codecov/vite-plugin";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

export default defineConfig({
  server: {
    port: 8080,
    host: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    copyFontsPlugin(),
    // nodePolyfills block removed entirely
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
      compress: { drop_console: true },
    },
    outDir: "dist", // Output directory for the build
    assetsDir: "assets", // Directory for static assets within the build output
    sourcemap: false, // Disable sourcemaps for production build
    target: 'esnext',
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
      '@brainstrike/db': path.resolve(__dirname, '../../packages/db/dist/index.js'),
    },
  },  
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: [
      '@electric-sql/pglite',
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
