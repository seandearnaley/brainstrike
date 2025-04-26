/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE: string;
  // Add other environment variables here...
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
