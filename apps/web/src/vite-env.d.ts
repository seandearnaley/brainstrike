/// <reference types="vite/client" />

// Type declarations for PNG assets with ?url suffix
declare module '*.png?url' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly MODE: string;
  readonly VITE_APP_TITLE: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_QUEUE_TELEMETRY_API_KEY?: string;
  readonly VITE_QUEUE_TELEMETRY_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
