import { defaultCollator } from './file-node-collator';
import {
  getDirectoryGroupDisplayName,
  getDirectoryGroupKey,
  getRootFolderDisplayName,
} from './path-display';

// Grouping system types
export type GroupKey = string | number;
export type GroupFunction<T = unknown> = (item: T) => GroupKey;
export type GroupBandFunction<T = unknown> = (item: T) => string;

// Size threshold constants (in bytes)
export const SIZE_THRESHOLDS = {
  small: 1024, // 1 KB
  medium: 10_240, // 10 KB
  large: 102_400, // 100 KB
  veryLarge: 1_048_576, // 1 MB
} as const;

// Token threshold constants
export const TOKEN_THRESHOLDS = {
  small: 100,
  medium: 500,
  large: 1000,
  veryLarge: 5000,
} as const;

export interface GroupConfig<T = unknown> {
  getDisambiguatedGroupLabel?: (groupKey: GroupKey) => string;
  getGroupLabel?: (groupKey: GroupKey) => string;
  groupBy: GroupFunction<T> | GroupBandFunction<T>;
  id: string;
  label: string;
  sortGroupedData?: (a: GroupedData<T>, b: GroupedData<T>) => number;
  sortGroups?: (a: GroupKey, b: GroupKey) => number;
}

export interface GroupedData<T = unknown> {
  count: number;
  groupKey: GroupKey;
  groupLabel: string;
  items: T[];
  totalSize: number;
  totalTokens: number;
}

/** Fallback type label for files without a recognized extension. */
export const EXTENSIONLESS_FILE_TYPE = 'file';

// Table data structure for preview panel
export interface TableRowData {
  compositeKey: string;
  id: string;
  path: string;
  rootFolderId: string;
  size?: number;
  tokens?: number;
  type: string; // File extension
}

// Pre-compiled Intl.Collator is ~40x faster than inline localeCompare
// while preserving localeCompare() default behavior.
const groupingCollator = defaultCollator;

// Predefined grouping configurations
export const GROUPING_CONFIGS = {
  none: {
    id: 'none',
    label: 'No Grouping',
    groupBy: () => 'all',
  },
  directory: {
    id: 'directory',
    label: 'By Directory',
    groupBy: (item: TableRowData) =>
      getDirectoryGroupKey({
        filePath: item.path,
        rootFolderId: item.rootFolderId,
      }),
    getGroupLabel: (groupKey: GroupKey) =>
      getDirectoryGroupDisplayName({
        groupKey: String(groupKey),
      }),
    getDisambiguatedGroupLabel: (groupKey: GroupKey) =>
      getDirectoryGroupDisplayName({
        groupKey: String(groupKey),
        useCanonicalRootLabel: true,
      }),
    sortGroupedData: (a: GroupedData<TableRowData>, b: GroupedData<TableRowData>) => {
      const primaryComparison = groupingCollator.compare(a.groupLabel, b.groupLabel);

      if (primaryComparison !== 0) {
        return primaryComparison;
      }

      return groupingCollator.compare(
        getDirectoryGroupDisplayName({
          groupKey: String(a.groupKey),
          useCanonicalRootLabel: true,
        }),
        getDirectoryGroupDisplayName({
          groupKey: String(b.groupKey),
          useCanonicalRootLabel: true,
        })
      );
    },
  },
  rootFolder: {
    id: 'rootFolder',
    label: 'By Root Folder',
    groupBy: (item: TableRowData) => item.rootFolderId,
    getGroupLabel: (groupKey: GroupKey) => getRootFolderDisplayName(String(groupKey)),
    sortGroups: (a: GroupKey, b: GroupKey) => groupingCollator.compare(String(a), String(b)),
  },
  fileType: {
    id: 'fileType',
    label: 'By File Type',
    groupBy: (item: TableRowData) => item.type,
    sortGroups: (a: GroupKey, b: GroupKey) => groupingCollator.compare(String(a), String(b)),
  },
  sizeSteps: {
    id: 'sizeSteps',
    label: 'By Size Range',
    groupBy: (item: TableRowData) => {
      const size = item.size || 0;
      if (size === 0) {
        return 'Unknown';
      }
      if (size < SIZE_THRESHOLDS.small) {
        return 'Small (< 1 KB)';
      }
      if (size < SIZE_THRESHOLDS.medium) {
        return 'Medium (1-10 KB)';
      }
      if (size < SIZE_THRESHOLDS.large) {
        return 'Large (10-100 KB)';
      }
      if (size < SIZE_THRESHOLDS.veryLarge) {
        return 'Very Large (100 KB - 1 MB)';
      }
      return 'Huge (> 1 MB)';
    },
    sortGroups: (a: GroupKey, b: GroupKey) => {
      const order = [
        'Unknown',
        'Small (< 1 KB)',
        'Medium (1-10 KB)',
        'Large (10-100 KB)',
        'Very Large (100 KB - 1 MB)',
        'Huge (> 1 MB)',
      ];
      return order.indexOf(String(a)) - order.indexOf(String(b));
    },
  },
  tokenSteps: {
    id: 'tokenSteps',
    label: 'By Token Range',
    groupBy: (item: TableRowData) => {
      const tokens = item.tokens || 0;
      if (tokens === 0) {
        return 'Unknown';
      }
      if (tokens < TOKEN_THRESHOLDS.small) {
        return 'Small (< 100)';
      }
      if (tokens < TOKEN_THRESHOLDS.medium) {
        return 'Medium (100-500)';
      }
      if (tokens < TOKEN_THRESHOLDS.large) {
        return 'Large (500-1K)';
      }
      if (tokens < TOKEN_THRESHOLDS.veryLarge) {
        return 'Very Large (1K-5K)';
      }
      return 'Huge (> 5K)';
    },
    sortGroups: (a: GroupKey, b: GroupKey) => {
      const order = [
        'Unknown',
        'Small (< 100)',
        'Medium (100-500)',
        'Large (500-1K)',
        'Very Large (1K-5K)',
        'Huge (> 5K)',
      ];
      return order.indexOf(String(a)) - order.indexOf(String(b));
    },
  },
} as const satisfies Record<string, GroupConfig<TableRowData>>;

// Helper function to group data
export function groupData<T extends { tokens?: number; size?: number }>(
  data: T[],
  config: GroupConfig<T>
): GroupedData<T>[] {
  if (config.id === 'none') {
    return [
      {
        groupKey: 'all',
        groupLabel: 'All Files',
        items: data,
        count: data.length,
        totalTokens: data.reduce((sum, item) => sum + (item.tokens || 0), 0),
        totalSize: data.reduce((sum, item) => sum + (item.size || 0), 0),
      },
    ];
  }

  const groups = new Map<GroupKey, T[]>();

  for (const item of data) {
    const groupKey = config.groupBy(item);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey)?.push(item);
  }

  const result: GroupedData<T>[] = Array.from(groups.entries()).map(([groupKey, items]) => ({
    groupKey,
    groupLabel: config.getGroupLabel ? config.getGroupLabel(groupKey) : String(groupKey),
    items,
    count: items.length,
    totalTokens: items.reduce((sum, item) => sum + (item.tokens || 0), 0),
    totalSize: items.reduce((sum, item) => sum + (item.size || 0), 0),
  }));

  if (config.getDisambiguatedGroupLabel) {
    const labelCounts = new Map<string, number>();
    for (const group of result) {
      labelCounts.set(group.groupLabel, (labelCounts.get(group.groupLabel) ?? 0) + 1);
    }

    for (const group of result) {
      if ((labelCounts.get(group.groupLabel) ?? 0) > 1) {
        group.groupLabel = config.getDisambiguatedGroupLabel(group.groupKey);
      }
    }
  }

  // Sort groups if sorter is provided
  if (config.sortGroupedData) {
    result.sort(config.sortGroupedData);
  } else if (config.sortGroups) {
    result.sort((a, b) => config.sortGroups?.(a.groupKey, b.groupKey) ?? 0);
  }

  return result;
}
