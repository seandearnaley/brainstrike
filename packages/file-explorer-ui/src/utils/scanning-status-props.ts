/**
 * Helper to compute ScanningStatus props.
 *
 * Extracted from FileExplorerLeftPanel to reduce cognitive complexity.
 */

interface ExpandProgress {
  loaded: number;
  total: number;
}

interface LoadingProgress {
  isInitialLoading?: boolean;
}

interface ScanningStatusPropsInput {
  cancelExpandAll: () => void;
  cancellable: boolean;
  expandAllProgress: ExpandProgress | null | undefined;
  handleCancelOperation: () => void;
  isCancelling: boolean;
  isExpandingAll: boolean;
  loadingProgress: LoadingProgress | null | undefined;
}

type ScanningStatusProps = {
  isScanning: boolean;
  cancellable: boolean;
  isCancelling: boolean;
  onCancel: () => void;
  currentPath?: string;
  /**
   * Monotonic count of directories processed so far. Preferred over a
   * percentage: `total` grows as lazy subfolders are discovered, so a
   * `loaded/total` percentage is non-monotonic and visually "flashes".
   * `loaded` only ever increases, so a raw count reads as steady growth.
   */
  loadedCount?: number;
  /** Best-known total directory count (may grow as discovery continues). */
  totalCount?: number;
} | null;

/**
 * Computes props for ScanningStatus component, or null if not visible.
 */
export function computeScanningStatusProps(input: ScanningStatusPropsInput): ScanningStatusProps {
  const {
    loadingProgress,
    isExpandingAll,
    expandAllProgress,
    cancellable,
    isCancelling,
    cancelExpandAll,
    handleCancelOperation,
  } = input;

  const isInitialLoading = loadingProgress?.isInitialLoading ?? false;
  const shouldShow = isInitialLoading || isExpandingAll;

  if (!shouldShow) {
    return null;
  }

  const computedCancellable = cancellable || isExpandingAll;
  const onCancel = isExpandingAll ? cancelExpandAll : handleCancelOperation;

  const baseProps = {
    isScanning: true as const,
    cancellable: computedCancellable,
    isCancelling,
    onCancel,
  };

  // Add optional props only when defined (exactOptionalPropertyTypes compliance)
  if (isExpandingAll) {
    // Show progress text even before first progress update to avoid visual gap
    const loaded = expandAllProgress?.loaded ?? 0;
    const total = expandAllProgress?.total ?? 0;
    const currentPath =
      total > 0 ? `Loading ${loaded}/${total} directories` : 'Preparing to expand directories...';

    // Only surface counts once a total is known; before that we show an
    // indeterminate spinner rather than a misleading "0/0".
    if (total > 0) {
      return { ...baseProps, currentPath, loadedCount: loaded, totalCount: total };
    }
    return { ...baseProps, currentPath };
  }

  return baseProps;
}
