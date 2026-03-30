import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: [
    'src/index.ts',
    'src/client.ts',
    'src/browser-safe.ts',
    'src/tool-metadata.ts',
    'src/provider-metadata.ts',
    'src/local-runtime.ts',
    'src/context-packer.ts',
  ],
  format: ['esm', 'cjs'],
  dts: {
    entry: [
      'src/index.ts',
      'src/client.ts',
      'src/browser-safe.ts',
      'src/tool-metadata.ts',
      'src/provider-metadata.ts',
      'src/local-runtime.ts',
      'src/context-packer.ts',
    ],
    compilerOptions: {
      composite: false,
    },
  },
  outDir: 'dist',
  // Keep previous declarations available during watch rebuilds so project-reference
  // consumers do not observe transient missing exports from @brainstrike/agent/client.
  clean: !options.watch,
  sourcemap: false,
  splitting: false,
  external: ['@brainstrike/types', '@mastra/core', '@mastra/mcp'],
}));
