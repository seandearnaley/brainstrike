import { useCallback } from 'react';
import type { GroupedData } from '../utils/grouping-configs';

interface UseGroupSelectionOptions<T> {
  getItemKey: (item: T) => string;
  onSelectionChange: (selections: Set<string>) => void;
  selections: Set<string>;
}

export function useGroupSelection<T>({
  selections,
  onSelectionChange,
  getItemKey,
}: UseGroupSelectionOptions<T>) {
  const handleGroupSelectAll = useCallback(
    (group: GroupedData<T>) => {
      const groupKeys = new Set(group.items.map(getItemKey));
      const newSelection = new Set(selections);
      for (const key of groupKeys) {
        newSelection.add(key);
      }
      onSelectionChange(newSelection);
    },
    [selections, onSelectionChange, getItemKey]
  );

  const handleGroupDeselectAll = useCallback(
    (group: GroupedData<T>) => {
      const groupKeys = new Set(group.items.map(getItemKey));
      const newSelection = new Set(selections);
      for (const key of groupKeys) {
        newSelection.delete(key);
      }
      onSelectionChange(newSelection);
    },
    [selections, onSelectionChange, getItemKey]
  );

  const isGroupFullySelected = useCallback(
    (group: GroupedData<T>) => {
      if (group.items.length === 0) {
        return false;
      }
      return group.items.every((item) => selections.has(getItemKey(item)));
    },
    [selections, getItemKey]
  );

  const isGroupPartiallySelected = useCallback(
    (group: GroupedData<T>) =>
      group.items.some((item) => selections.has(getItemKey(item))) && !isGroupFullySelected(group),
    [selections, getItemKey, isGroupFullySelected]
  );

  const toggleItemSelection = useCallback(
    (itemKey: string, checked: boolean) => {
      const newSelection = new Set(selections);
      if (checked) {
        newSelection.add(itemKey);
      } else {
        newSelection.delete(itemKey);
      }
      onSelectionChange(newSelection);
    },
    [selections, onSelectionChange]
  );

  const selectAll = useCallback(
    (items: T[]) => {
      const allKeys = new Set(items.map(getItemKey));
      onSelectionChange(allKeys);
    },
    [onSelectionChange, getItemKey]
  );

  const selectAllOnPage = useCallback(
    (items: T[]) => {
      const pageKeys = new Set(items.map(getItemKey));
      const newSelection = new Set(selections);
      for (const key of pageKeys) {
        newSelection.add(key);
      }
      onSelectionChange(newSelection);
    },
    [selections, onSelectionChange, getItemKey]
  );

  const deselectAll = useCallback(() => {
    onSelectionChange(new Set());
  }, [onSelectionChange]);

  const isAllSelected = useCallback(
    (items: T[]) => {
      if (items.length === 0) {
        return false;
      }
      return items.every((item) => selections.has(getItemKey(item)));
    },
    [selections, getItemKey]
  );

  return {
    deselectAll,
    handleGroupDeselectAll,
    handleGroupSelectAll,
    isAllSelected,
    isGroupFullySelected,
    isGroupPartiallySelected,
    selectAll,
    selectAllOnPage,
    toggleItemSelection,
  };
}
