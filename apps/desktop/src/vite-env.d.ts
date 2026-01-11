/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MODE: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_QUEUE_TELEMETRY_ENDPOINT?: string;
  readonly VITE_QUEUE_TELEMETRY_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
