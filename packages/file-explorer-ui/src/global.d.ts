export {};

declare global {
  interface Window {
    __PW_TEST__?: boolean;
    __v2VisibleRowsPaths?: string[];
    feTest?: {
      visibleRecalcCount?: number;
      bumpVisibleRecalc?: () => void;
      getVisibleRecalcCount?: () => number;
      waitForName?: (name: string, timeout?: number) => Promise<boolean>;
      visibleNames?: string[];
      visiblePaths?: string[];
    };
  }
  interface WindowEventMap {
    'optimized-file-tree-nudge': CustomEvent<{ detail: number }>;
    'v2-visible-rows-updated': CustomEvent<{ paths: string[] }>;
  }
}
