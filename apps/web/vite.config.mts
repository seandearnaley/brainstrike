import path from "node:path";
/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
// import { nodePolyfills } from "vite-plugin-node-polyfills"; // Removed
import { codecovVitePlugin } from "@codecov/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
    rollupOptions: {
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
    },
  },
  optimizeDeps: {
    // Exclude workspace packages from optimization as they are treated as external
    exclude: [
      '@brainstrike/types',
      '@brainstrike/hooks',
      '@brainstrike/ui',
      '@brainstrike/utils',
      '@brainstrike/file-explorer'
    ]
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
