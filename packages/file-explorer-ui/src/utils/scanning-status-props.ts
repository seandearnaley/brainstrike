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
  loadingProgress: LoadingProgress | null | undefined;
  isExpandingAll: boolean;
  expandAllProgress: ExpandProgress | null | undefined;
  cancellable: boolean;
  isCancelling: boolean;
  cancelExpandAll: () => void;
  handleCancelOperation: () => void;
}

type ScanningStatusProps = {
  isScanning: boolean;
  cancellable: boolean;
  isCancelling: boolean;
  onCancel: () => void;
  currentPath?: string;
  percentage?: number;
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
    const percentage = total > 0 ? Math.round((loaded / total) * 100) : undefined;

    // Only include percentage if defined
    if (percentage !== undefined) {
      return { ...baseProps, currentPath, percentage };
    }
    return { ...baseProps, currentPath };
  }

  return baseProps;
}
