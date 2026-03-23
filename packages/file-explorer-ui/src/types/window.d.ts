export {};

declare global {
  interface Window {
    desktopLifecycle?: {
      isTestMode?: boolean;
    };
  }
}
