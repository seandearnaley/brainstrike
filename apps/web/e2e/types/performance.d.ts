/**
 * Type definitions for performance testing
 */

export interface MemorySnapshot {
  canvasElements: number;
  domNodes: number;
  iframes: number;
  imgElements: number;
  label: string;
  reactComponents: number;
  svgElements: number;
  timestamp: number;
  totalMB: number;
  usedMB: number;
}

export interface MemoryAnalysis {
  canvasGrowth: number;
  domNodeGrowth: number;
  imgGrowth: number;
  memoryGrowthMB: number;
  reactComponentGrowth: number;
  snapshots: MemorySnapshot[];
  svgGrowth: number;
}

export interface MemoryProfiler {
  getAnalysis: () => MemoryAnalysis | { error: string };
  snapshots: MemorySnapshot[];
  start: () => void;
  takeSnapshot: (label: string) => void;
  tracking: boolean;
}

export interface RenderTracker {
  count: number;
  getStats: () => {
    totalRenders: number;
    recentRenderStorm: number;
  };
  renderTimes: number[];
  reset: () => void;
  track: () => void;
}

export interface PerformanceMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
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
