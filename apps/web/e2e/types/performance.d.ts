/**
 * Type definitions for performance testing
 */

export interface MemorySnapshot {
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
}

export interface MemoryAnalysis {
  memoryGrowthMB: number;
  domNodeGrowth: number;
  reactComponentGrowth: number;
  canvasGrowth: number;
  imgGrowth: number;
  svgGrowth: number;
  snapshots: MemorySnapshot[];
}

export interface MemoryProfiler {
  snapshots: MemorySnapshot[];
  tracking: boolean;
  start: () => void;
  takeSnapshot: (label: string) => void;
  getAnalysis: () => MemoryAnalysis | { error: string };
}

export interface RenderTracker {
  count: number;
  renderTimes: number[];
  track: () => void;
  getStats: () => {
    totalRenders: number;
    recentRenderStorm: number;
  };
  reset: () => void;
}

export interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

// Extend global interfaces
declare global {
  interface Window {
    __memoryProfiler?: MemoryProfiler | undefined;
    __renderTracker?: RenderTracker | undefined;
    gc?: (() => void) | undefined;
  }

  interface Performance {
    memory?: PerformanceMemory;
  }

  interface GlobalThis {
    process?: {
      env?: {
        DEBUG?: string;
        PERFORMANCE_LOGGING?: string;
      };
    };
  }
}
