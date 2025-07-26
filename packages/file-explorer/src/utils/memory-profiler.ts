/**
 * Memory profiling utilities to identify real memory leaks
 */

export interface MemorySnapshot {
  timestamp: number;
  used: number;
  total: number;
  limit: number;
  objects: Record<string, number>;
}

export class MemoryProfiler {
  private snapshots: MemorySnapshot[] = [];
  private tracking = false;
  private interval?: NodeJS.Timeout | number;

  start(intervalMs = 1000) {
    this.tracking = true;
    this.snapshots = [];

    this.interval = setInterval(() => {
      if (this.tracking) {
        this.takeSnapshot();
      }
    }, intervalMs);

    // Take initial snapshot
    this.takeSnapshot();
  }

  stop() {
    this.tracking = false;
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  private takeSnapshot() {
    // biome-ignore lint/suspicious/noExplicitAny: Browser memory API not standardized
    const memory = (performance as any).memory;
    if (!memory) return;

    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      used: memory.usedJSHeapSize,
      total: memory.totalJSHeapSize,
      limit: memory.jsHeapSizeLimit,
      objects: this.getObjectCounts(),
    };

    this.snapshots.push(snapshot);

    // Keep only last 50 snapshots to avoid memory growth from profiler itself
    if (this.snapshots.length > 50) {
      this.snapshots = this.snapshots.slice(-50);
    }
  }

  private getObjectCounts(): Record<string, number> {
    // Attempt to get object counts from available APIs
    const counts: Record<string, number> = {};

    try {
      // Check for React DevTools memory info
      // biome-ignore lint/suspicious/noExplicitAny: DevTools global variables need any type
      if ((window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__) {
        // biome-ignore lint/suspicious/noExplicitAny: DevTools global variables need any type
        const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
        if (hook.getFiberRoots) {
          // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for dynamic keys
          counts['reactFiberRoots'] = hook.getFiberRoots(1).size || 0;
        }
      }

      // Check for DOM nodes
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for dynamic keys
      counts['domNodes'] = document.querySelectorAll('*').length;

      // Check for event listeners (approximation)
      // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket notation for dynamic keys
      counts['eventListeners'] = this.estimateEventListeners();
    } catch (_error) {
      // Ignore errors in object counting
    }

    return counts;
  }

  private estimateEventListeners(): number {
    let count = 0;
    try {
      // Count elements with common event attributes
      const elements = document.querySelectorAll(
        '[onclick], [onchange], [onmouseover], [onmouseout]'
      );
      count += elements.length;

      // This is a rough estimate - real memory profiling would need browser DevTools
    } catch (_error) {
      // Ignore
    }
    return count;
  }

  getAnalysis() {
    if (this.snapshots.length < 2) {
      return { error: 'Need at least 2 snapshots for analysis' };
    }

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];

    if (!first || !last) {
      throw new Error('Insufficient snapshots for analysis');
    }

    const peak = this.snapshots.reduce((max, snap) => (snap.used > max.used ? snap : max));

    const totalGrowth = last.used - first.used;
    const timeElapsed = last.timestamp - first.timestamp;
    const growthRate = totalGrowth / (timeElapsed / 1000); // bytes per second

    return {
      summary: {
        totalGrowthMB: Math.round(totalGrowth / 1024 / 1024),
        peakUsageMB: Math.round(peak.used / 1024 / 1024),
        currentUsageMB: Math.round(last.used / 1024 / 1024),
        growthRateMBPerSec: Math.round((growthRate / 1024 / 1024) * 100) / 100,
        durationSec: Math.round(timeElapsed / 1000),
      },
      objectGrowth: this.analyzeObjectGrowth(first, last),
      snapshots: this.snapshots.map((s) => ({
        timestamp: s.timestamp,
        usedMB: Math.round(s.used / 1024 / 1024),
        objects: s.objects,
      })),
    };
  }

  private analyzeObjectGrowth(first: MemorySnapshot, last: MemorySnapshot) {
    const growth: Record<string, number> = {};

    for (const [key, lastCount] of Object.entries(last.objects)) {
      const firstCount = first.objects[key] || 0;
      growth[key] = lastCount - firstCount;
    }

    return growth;
  }

  // Force garbage collection if available
  static forceGC() {
    // biome-ignore lint/suspicious/noExplicitAny: DevTools global variables need any type
    if ((window as any).gc) {
      // biome-ignore lint/suspicious/noExplicitAny: DevTools global variables need any type
      (window as any).gc();
    }
  }

  // Get current memory usage
  static getCurrentMemory() {
    // biome-ignore lint/suspicious/noExplicitAny: Browser memory API not standardized
    const memory = (performance as any).memory;
    if (!memory) return null;

    return {
      usedMB: Math.round(memory.usedJSHeapSize / 1024 / 1024),
      totalMB: Math.round(memory.totalJSHeapSize / 1024 / 1024),
      limitMB: Math.round(memory.jsHeapSizeLimit / 1024 / 1024),
    };
  }
}
