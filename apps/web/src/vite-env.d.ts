/// <reference types="vite/client" />

// Type declarations for PNG assets with ?url suffix
declare module '*.png?url' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
  readonly MODE: string;
}

// biome-ignore lint/correctness/noUnusedVariables: Global interface extension for Vite
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
