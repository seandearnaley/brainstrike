import type { TabAppearance, TabStripItem } from './types';

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

/** Fields compared by identity (`===`). */
const IDENTITY_KEYS = [
  'closable',
  'closeTestId',
  'icon',
  'id',
  'label',
  'mark',
  'panelDomId',
  'reorderable',
  'status',
  'statusLabel',
  'tabDomId',
  'testId',
  'tooltip',
] as const satisfies readonly (keyof TabStripItem)[];

/** `TabAppearance` fields, compared by identity inside the structural check. */
const APPEARANCE_KEYS = [
  'idleClassName',
  'selectedClassName',
  'style',
] as const satisfies readonly (keyof TabAppearance)[];
type UncomparedAppearanceKey = Exclude<keyof TabAppearance, (typeof APPEARANCE_KEYS)[number]>;
const EVERY_APPEARANCE_FIELD_COMPARED: [UncomparedAppearanceKey] extends [never]
  ? true
  : UncomparedAppearanceKey = true;

function areAppearancesEqual(
  left: TabAppearance | undefined,
  right: TabAppearance | undefined
): boolean {
  if (left === right) {
    return true;
  }
  if (!(left && right)) {
    return false;
  }
  return (
    EVERY_APPEARANCE_FIELD_COMPARED && APPEARANCE_KEYS.every((key) => left[key] === right[key])
  );
}

/** Fields compared structurally below. */
type StructuralKey = 'appearance' | 'dataAttributes';

/**
 * Compile-time exhaustiveness: a new `TabStripItem` field that is neither an
 * identity key nor a structural key makes this `never` check fail, so memo
 * equality can never silently ignore a rendered field.
 */
type UncomparedKey = Exclude<keyof TabStripItem, (typeof IDENTITY_KEYS)[number] | StructuralKey>;
const EVERY_FIELD_COMPARED: [UncomparedKey] extends [never] ? true : UncomparedKey = true;

/**
 * Value equality over every rendered field, so consumers need not keep the ITEM
 * objects stable. `icon`, `mark` and `appearance.style` are compared by
 * reference: memoize them (per id + state) or every tab re-renders on each
 * parent render.
 */
export function areTabStripItemsEqual(left: TabStripItem, right: TabStripItem): boolean {
  if (left === right) {
    return true;
  }
  return (
    EVERY_FIELD_COMPARED &&
    IDENTITY_KEYS.every((key) => left[key] === right[key]) &&
    areAppearancesEqual(left.appearance, right.appearance) &&
    areRecordsEqual(left.dataAttributes, right.dataAttributes)
  );
}
