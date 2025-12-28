/**
 * Helper to compute ScanningStatus props.
 *
 * Extracted from FileExplorerLeftPanel to reduce cognitive complexity.
 */

type ExpandProgress = {
  loaded: number;
  total: number;
};

type LoadingProgress = {
  isInitialLoading?: boolean;
};

type ScanningStatusPropsInput = {
  loadingProgress: LoadingProgress | null | undefined;
  isExpandingAll: boolean;
  expandAllProgress: ExpandProgress | null | undefined;
  cancellable: boolean;
  isCancelling: boolean;
  cancelExpandAll: () => void;
  handleCancelOperation: () => void;
};

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
  if (isExpandingAll && expandAllProgress) {
    const currentPath = `Loading ${expandAllProgress.loaded}/${expandAllProgress.total} directories`;
    const percentage =
      expandAllProgress.total > 0
        ? Math.round((expandAllProgress.loaded / expandAllProgress.total) * 100)
        : undefined;

    // Only include percentage if defined
    if (percentage !== undefined) {
      return { ...baseProps, currentPath, percentage };
    }
    return { ...baseProps, currentPath };
  }

  return baseProps;
}
