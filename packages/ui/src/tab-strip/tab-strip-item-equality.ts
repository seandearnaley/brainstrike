import type { TabStripItem } from './types';

function areRecordsEqual(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

/** Value equality over every rendered field, so consumers need not keep item objects stable. */
export function areTabStripItemsEqual(left: TabStripItem, right: TabStripItem): boolean {
  if (left === right) {
    return true;
  }
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.tabDomId === right.tabDomId &&
    left.panelDomId === right.panelDomId &&
    left.closable === right.closable &&
    left.icon === right.icon &&
    left.mark === right.mark &&
    left.status === right.status &&
    left.statusLabel === right.statusLabel &&
    left.tooltip === right.tooltip &&
    left.testId === right.testId &&
    left.closeTestId === right.closeTestId &&
    left.appearance?.idleClassName === right.appearance?.idleClassName &&
    left.appearance?.selectedClassName === right.appearance?.selectedClassName &&
    left.appearance?.style === right.appearance?.style &&
    areRecordsEqual(left.dataAttributes, right.dataAttributes)
  );
}
