/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly MODE: string;
  readonly PROD: boolean;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_QUEUE_TELEMETRY_API_KEY?: string;
  readonly VITE_QUEUE_TELEMETRY_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
