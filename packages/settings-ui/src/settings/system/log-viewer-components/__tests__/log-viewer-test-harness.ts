interface MockVirtualizerOptions {
  count: number;
}

export function createMockLogVirtualizer({ count }: MockVirtualizerOptions) {
  return {
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        end: (index + 1) * 30,
        index,
        key: index,
        size: 30,
        start: index * 30,
      })),
    measure: () => {},
    measureElement: () => {},
    scrollToIndex: () => {},
  };
}

export function installLogViewerDomStubs(): void {
  global.ResizeObserver = class ResizeObserver {
    disconnect() {}
    observe() {}
    unobserve() {}
  };
  (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () =>
    false;
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
}
