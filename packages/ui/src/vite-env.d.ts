/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
  // Add other environment variables here...
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Type declarations for PNG assets with ?url suffix
declare module '*.png?url' {
  const src: string;
  export default src;
}
