/**
 * Type definitions for performance testing
 */

export type MemorySnapshot = {
  label: string;
  timestamp: number;
  usedMB: number;
  totalMB: number;
  domNodes: number;
  reactComponents: number;
  canvasElements: number;
  imgElements: number;
  svgElements: number;
  iframes: number;
};

export type MemoryAnalysis = {
  memoryGrowthMB: number;
  domNodeGrowth: number;
  reactComponentGrowth: number;
  canvasGrowth: number;
  imgGrowth: number;
  svgGrowth: number;
  snapshots: MemorySnapshot[];
};

export type MemoryProfiler = {
  snapshots: MemorySnapshot[];
  tracking: boolean;
  start: () => void;
  takeSnapshot: (label: string) => void;
  getAnalysis: () => MemoryAnalysis | { error: string };
};

export type RenderTracker = {
  count: number;
  renderTimes: number[];
  track: () => void;
  getStats: () => {
    totalRenders: number;
    recentRenderStorm: number;
  };
  reset: () => void;
};

export type PerformanceMemory = {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
};

// Extend global interfaces
declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface Window {
    __memoryProfiler?: MemoryProfiler | undefined;
    __renderTracker?: RenderTracker | undefined;
    gc?: (() => void) | undefined;
  }

  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface Performance {
    memory?: PerformanceMemory;
  }

  // biome-ignore lint/style/useConsistentTypeDefinitions: Interface required for global declaration merging - types cannot be merged
  interface GlobalThis {
    process?: {
      env?: {
        DEBUG?: string;
        PERFORMANCE_LOGGING?: string;
      };
    };
  }
}
