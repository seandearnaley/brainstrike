/**
 * Debounce utility for high-frequency operations
 */

// biome-ignore lint/suspicious/noExplicitAny: Generic function signature requires any for flexibility
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout | number;

  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
}

// biome-ignore lint/suspicious/noExplicitAny: Generic function signature requires any for flexibility
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= delay) {
      lastCall = now;
      func(...args);
    }
  };
}

export function batchOperations<T>(operations: T[], batchSize = 10, delay = 0): Promise<T[]> {
  return new Promise((resolve) => {
    const results: T[] = [];
    let currentIndex = 0;

    function scheduleNext() {
      if (delay > 0) {
        setTimeout(processBatch, delay);
      } else {
        requestAnimationFrame(processBatch);
      }
    }

    function processBatch() {
      const endIndex = Math.min(currentIndex + batchSize, operations.length);

      for (let i = currentIndex; i < endIndex; i++) {
        const operation = operations[i];
        if (operation !== undefined) {
          results.push(operation);
        }
      }

      currentIndex = endIndex;

      if (currentIndex >= operations.length) {
        resolve(results);
      } else {
        scheduleNext();
      }
    }

    processBatch();
  });
}
