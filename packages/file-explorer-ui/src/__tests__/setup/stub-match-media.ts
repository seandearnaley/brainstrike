/**
 * react-resizable-panels v4 probes `matchMedia('(pointer: coarse)').matches`
 * while mounting a Group — which every FileTabBody render does now that the
 * explorer pane is open by default (BST-1318). The shared setup's matchMedia
 * is a vi.fn whose implementation is reset between tests (returns undefined),
 * so tests install this PLAIN function instead.
 */
export function stubMatchMedia(): void {
  window.matchMedia = ((query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}
