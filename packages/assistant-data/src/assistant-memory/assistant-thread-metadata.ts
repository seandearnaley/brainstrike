import type {
  AssistantThreadColorId,
  AssistantThreadIconId,
  AssistantThreadMetadata,
  MutableAssistantThreadMetadata,
} from './assistant-thread-types.js';
import { ASSISTANT_THREAD_COLOR_IDS, ASSISTANT_THREAD_ICON_IDS } from './assistant-thread-types.js';
import {
  isRecord,
  optionalBoolean,
  optionalRecord,
  optionalString,
} from './assistant-value-coercion.js';

const ASSISTANT_THREAD_ICON_ID_SET = new Set<string>(ASSISTANT_THREAD_ICON_IDS);

const ASSISTANT_THREAD_COLOR_ID_SET = new Set<string>(ASSISTANT_THREAD_COLOR_IDS);

const ASSISTANT_THREAD_METADATA_KEYS = new Set<string>([
  'checkoutBranch',
  'checkoutLocalRootId',
  'checkoutMode',
  'checkoutWorktreeId',
  'checkoutWorktreePath',
  'color',
  'forgePrUrl',
  'forgePrWatch',
  'icon',
  'model',
  'modelSettings',
  'operatingRootDisplayName',
  'operatingRootId',
  'operatingRootPath',
  'provider',
  'providerOptions',
  'secondaryRootIds',
  'source',
]);

function optionalThreadIconId(value: unknown): AssistantThreadIconId | undefined {
  return typeof value === 'string' && ASSISTANT_THREAD_ICON_ID_SET.has(value)
    ? (value as AssistantThreadIconId)
    : undefined;
}

function optionalThreadColorId(value: unknown): AssistantThreadColorId | undefined {
  return typeof value === 'string' && ASSISTANT_THREAD_COLOR_ID_SET.has(value)
    ? (value as AssistantThreadColorId)
    : undefined;
}

function optionalOperatingRootMetadataString(
  metadata: Record<string, unknown>,
  key: 'operatingRootDisplayName' | 'operatingRootId' | 'operatingRootPath',
  label: string
): string | undefined {
  if (!Object.hasOwn(metadata, key)) {
    return;
  }
  const value = optionalString(metadata[key]);
  if (!value) {
    throw new Error(`Invalid assistant thread metadata ${label}.`);
  }
  return value;
}

function optionalSecondaryRootIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error('Invalid assistant thread metadata secondary root ids.');
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    // Trim-empty matches `optionalString`'s semantics: a whitespace-only id is
    // no id at all, so it is rejected rather than silently persisted.
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('Invalid assistant thread metadata secondary root ids.');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      ids.push(entry);
    }
  }
  return ids;
}

function assertOptionalThreadMetadataString(value: string | undefined, label: string): void {
  if (value !== undefined && !optionalString(value)) {
    throw new Error(`Invalid assistant thread metadata ${label}.`);
  }
}

function assertCompleteOperatingRootMetadata(metadata: {
  readonly operatingRootDisplayName?: string | undefined;
  readonly operatingRootId?: string | undefined;
  readonly operatingRootPath?: string | undefined;
}): void {
  const hasAnyOperatingRootMetadata = Boolean(
    metadata.operatingRootDisplayName || metadata.operatingRootId || metadata.operatingRootPath
  );
  if (
    hasAnyOperatingRootMetadata &&
    !(metadata.operatingRootDisplayName && metadata.operatingRootId)
  ) {
    throw new Error('Assistant thread operating-root metadata is incomplete.');
  }
}

const CHECKOUT_MODES = new Set(['local', 'worktree']);

function optionalCheckoutMode(value: unknown): 'local' | 'worktree' | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !CHECKOUT_MODES.has(value)) {
    throw new Error('Invalid assistant thread metadata checkout mode.');
  }
  return value as 'local' | 'worktree';
}

/**
 * All-or-nothing validation for the thread's checkout, mirroring
 * `assertCompleteOperatingRootMetadata`.
 *
 * `checkoutWorktreeId` is the AUTHORITY in worktree mode (exactly like
 * `operatingRootId` is for the folder binding), `checkoutWorktreePath` is the
 * display hint the chip's tooltip renders, and `checkoutLocalRootId` is the
 * durable root a later hand-off restores. New worktree writes need all three:
 * an id with no path renders a chip with nothing to show, a path with no id has
 * no durable identity to resolve, and a missing Local root would lose the
 * durable hand-off target. Reads tolerate only that last omission for legacy
 * rows, allowing the explicit warn/toast hand-off path to retain the current
 * primary folder. A LOCAL checkout carrying any of those keys is not "mostly
 * right" — it is two contradictory statements about where the thread works,
 * and it is rejected rather than silently pruned.
 *
 * `updateThreadMetadata` owns the key-removal transitions this shape needs.
 * Every checkout-mode patch removes the per-checkout branch before merging, so
 * a detached worktree cannot inherit the previous checkout's branch. A patch
 * specifically to Local also removes both worktree keys and the durable Local
 * root in the same SQL update. Every non-checkout metadata patch keeps the
 * repository's ordinary JSONB-merge semantics.
 */
interface CheckoutMetadataShape {
  readonly checkoutBranch?: string | undefined;
  readonly checkoutLocalRootId?: string | undefined;
  readonly checkoutMode?: 'local' | 'worktree' | undefined;
  readonly checkoutWorktreeId?: string | undefined;
  readonly checkoutWorktreePath?: string | undefined;
}

function assertCompleteCheckoutMetadata(
  metadata: CheckoutMetadataShape,
  requireLocalRootId: boolean
): void {
  const hasAnyCheckoutMetadata = Boolean(
    metadata.checkoutBranch ||
      metadata.checkoutLocalRootId ||
      metadata.checkoutMode ||
      metadata.checkoutWorktreeId ||
      metadata.checkoutWorktreePath
  );
  if (!hasAnyCheckoutMetadata) {
    return;
  }
  if (!metadata.checkoutMode) {
    throw new Error('Assistant thread checkout metadata is incomplete.');
  }
  if (metadata.checkoutMode === 'worktree') {
    if (
      !(metadata.checkoutWorktreeId && metadata.checkoutWorktreePath) ||
      (requireLocalRootId && !metadata.checkoutLocalRootId)
    ) {
      throw new Error('Assistant thread checkout metadata is incomplete.');
    }
    return;
  }
  if (
    metadata.checkoutLocalRootId ||
    metadata.checkoutWorktreeId ||
    metadata.checkoutWorktreePath
  ) {
    throw new Error('Assistant thread checkout metadata is inconsistent.');
  }
}

function assertCompleteCheckoutMetadataForRead(metadata: CheckoutMetadataShape): void {
  assertCompleteCheckoutMetadata(metadata, false);
}

function assertCompleteCheckoutMetadataForWrite(metadata: CheckoutMetadataShape): void {
  assertCompleteCheckoutMetadata(metadata, true);
}

function sanitizeCheckoutMetadata(
  value: Record<string, unknown>
): Pick<
  AssistantThreadMetadata,
  | 'checkoutBranch'
  | 'checkoutLocalRootId'
  | 'checkoutMode'
  | 'checkoutWorktreeId'
  | 'checkoutWorktreePath'
> {
  const checkoutBranch = optionalString(value['checkoutBranch']);
  const checkoutLocalRootId = optionalString(value['checkoutLocalRootId']);
  const checkoutMode = optionalCheckoutMode(value['checkoutMode']);
  const checkoutWorktreeId = optionalString(value['checkoutWorktreeId']);
  const checkoutWorktreePath = optionalString(value['checkoutWorktreePath']);
  const checkoutMetadata = {
    ...(checkoutBranch ? { checkoutBranch } : {}),
    ...(checkoutLocalRootId ? { checkoutLocalRootId } : {}),
    ...(checkoutMode ? { checkoutMode } : {}),
    ...(checkoutWorktreeId ? { checkoutWorktreeId } : {}),
    ...(checkoutWorktreePath ? { checkoutWorktreePath } : {}),
  };
  assertCompleteCheckoutMetadataForRead(checkoutMetadata);
  return checkoutMetadata;
}

export function sanitizeThreadMetadata(value: unknown): AssistantThreadMetadata | undefined {
  if (!isRecord(value)) {
    return;
  }
  const metadata: MutableAssistantThreadMetadata = {};
  Object.assign(metadata, sanitizeCheckoutMetadata(value));
  const icon = optionalThreadIconId(value['icon']);
  const color = optionalThreadColorId(value['color']);
  const forgePrUrl = optionalString(value['forgePrUrl']);
  const forgePrWatch = optionalBoolean(value['forgePrWatch']);
  const provider = optionalString(value['provider']);
  const model = optionalString(value['model']);
  const modelSettings = optionalRecord(value['modelSettings']);
  const operatingRootDisplayName = optionalOperatingRootMetadataString(
    value,
    'operatingRootDisplayName',
    'operating root display name'
  );
  const operatingRootId = optionalOperatingRootMetadataString(
    value,
    'operatingRootId',
    'operating root id'
  );
  const operatingRootPath = optionalOperatingRootMetadataString(
    value,
    'operatingRootPath',
    'operating root path'
  );
  const providerOptions = optionalRecord(value['providerOptions']);
  const source = optionalString(value['source']);
  const secondaryRootIds = optionalSecondaryRootIds(value['secondaryRootIds']);
  assertCompleteOperatingRootMetadata({
    ...(operatingRootDisplayName ? { operatingRootDisplayName } : {}),
    ...(operatingRootId ? { operatingRootId } : {}),
    ...(operatingRootPath ? { operatingRootPath } : {}),
  });

  if (icon) {
    metadata.icon = icon;
  }
  if (color) {
    metadata.color = color;
  }
  if (forgePrUrl) {
    metadata.forgePrUrl = forgePrUrl;
  }
  if (forgePrWatch !== undefined) {
    metadata.forgePrWatch = forgePrWatch;
  }
  if (provider) {
    metadata.provider = provider;
  }
  if (model) {
    metadata.model = model;
  }
  if (modelSettings) {
    metadata.modelSettings = modelSettings;
  }
  if (operatingRootDisplayName) {
    metadata.operatingRootDisplayName = operatingRootDisplayName;
  }
  if (operatingRootId) {
    metadata.operatingRootId = operatingRootId;
  }
  if (operatingRootPath) {
    metadata.operatingRootPath = operatingRootPath;
  }
  if (secondaryRootIds) {
    metadata.secondaryRootIds = secondaryRootIds;
  }
  if (providerOptions) {
    metadata.providerOptions = providerOptions;
  }
  if (source) {
    metadata.source = source;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function assertPersistableThreadMetadata(metadata: AssistantThreadMetadata): void {
  const metadataValue: unknown = metadata;
  if (!isRecord(metadataValue)) {
    throw new Error('Assistant thread metadata must be an object.');
  }
  for (const key of Object.keys(metadataValue)) {
    if (!ASSISTANT_THREAD_METADATA_KEYS.has(key)) {
      throw new Error(`Invalid assistant thread metadata key: ${key}.`);
    }
  }
  if (metadata.icon !== undefined && !ASSISTANT_THREAD_ICON_ID_SET.has(metadata.icon)) {
    throw new Error('Invalid assistant thread metadata icon.');
  }
  if (metadata.color !== undefined && !ASSISTANT_THREAD_COLOR_ID_SET.has(metadata.color)) {
    throw new Error('Invalid assistant thread metadata color.');
  }
  optionalCheckoutMode(metadata.checkoutMode);
  assertCompleteCheckoutMetadataForWrite(metadata);
  assertOptionalThreadMetadataString(metadata.checkoutBranch, 'checkout branch');
  assertOptionalThreadMetadataString(metadata.checkoutLocalRootId, 'checkout local root id');
  assertOptionalThreadMetadataString(metadata.checkoutWorktreeId, 'checkout worktree id');
  assertOptionalThreadMetadataString(metadata.checkoutWorktreePath, 'checkout worktree path');
  assertOptionalThreadMetadataString(metadata.forgePrUrl, 'forge pull request URL');
  if (metadata.forgePrWatch !== undefined && typeof metadata.forgePrWatch !== 'boolean') {
    throw new Error('Invalid assistant thread metadata forge watch flag.');
  }
  assertCompleteOperatingRootMetadata(metadata);
  assertOptionalThreadMetadataString(metadata.provider, 'provider');
  assertOptionalThreadMetadataString(metadata.model, 'model');
  assertOptionalThreadMetadataString(
    metadata.operatingRootDisplayName,
    'operating root display name'
  );
  assertOptionalThreadMetadataString(metadata.operatingRootId, 'operating root id');
  assertOptionalThreadMetadataString(metadata.operatingRootPath, 'operating root path');
  assertOptionalThreadMetadataString(metadata.source, 'source');
  optionalSecondaryRootIds(metadata.secondaryRootIds);
  if (metadata.modelSettings !== undefined && !optionalRecord(metadata.modelSettings)) {
    throw new Error('Invalid assistant thread metadata model settings.');
  }
  if (metadata.providerOptions !== undefined && !optionalRecord(metadata.providerOptions)) {
    throw new Error('Invalid assistant thread metadata provider options.');
  }
}

/** Checkout transitions are single-thread writes because their key projection is atomic. */
export function assertBulkThreadMetadataPatch(metadata: AssistantThreadMetadata): void {
  if (
    'checkoutBranch' in metadata ||
    'checkoutLocalRootId' in metadata ||
    'checkoutMode' in metadata ||
    'checkoutWorktreeId' in metadata ||
    'checkoutWorktreePath' in metadata
  ) {
    throw new Error('Bulk assistant thread metadata updates cannot change checkout state.');
  }
}

/** Test-only seam for the sanitizer — see thread-metadata.test.ts. */
export function sanitizeThreadMetadataForTest(value: unknown): AssistantThreadMetadata | undefined {
  return sanitizeThreadMetadata(value);
}

/** Test-only seam for the persistence assertion — see thread-metadata.test.ts. */
export function assertPersistableThreadMetadataForTest(metadata: AssistantThreadMetadata): void {
  assertPersistableThreadMetadata(metadata);
}

/**
 * Narrows metadata for persistence: `secondaryRootIds`, when present, is
 * replaced with its deduped form (see `optionalSecondaryRootIds`) so every
 * write path — single-thread or bulk — serializes the same normalized shape.
 * Callers must validate the metadata first (`assertPersistableThreadMetadata`
 * / `requireNonemptyThreadMetadata`); this does not re-validate.
 */
export function normalizeThreadMetadataForPersistence(
  metadata: AssistantThreadMetadata
): AssistantThreadMetadata {
  const dedupedSecondaryRootIds = metadata.secondaryRootIds
    ? optionalSecondaryRootIds(metadata.secondaryRootIds)
    : undefined;
  return {
    ...metadata,
    ...(dedupedSecondaryRootIds ? { secondaryRootIds: dedupedSecondaryRootIds } : {}),
  };
}

export function requireAssistantThreadIds(threadIds: readonly string[]): readonly string[] {
  if (!Array.isArray(threadIds) || threadIds.length === 0) {
    throw new Error('At least one assistant thread id is required.');
  }
  const seenIds = new Set<string>();
  for (const threadId of threadIds) {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new Error('Assistant thread id is required.');
    }
    if (seenIds.has(threadId)) {
      throw new Error(`Duplicate assistant thread id: ${threadId}.`);
    }
    seenIds.add(threadId);
  }
  return threadIds;
}

export function requireNonemptyThreadMetadata(metadata: AssistantThreadMetadata): void {
  assertPersistableThreadMetadata(metadata);
  if (Object.keys(metadata).length === 0) {
    throw new Error('Assistant thread metadata must include at least one field.');
  }
}

export function threadIdValuesSql(threadIds: readonly string[]): string {
  return threadIds.map((_, index) => `($${index + 1})`).join(', ');
}

export function assertAllBulkThreadsFound(row: Record<string, unknown> | undefined): void {
  if (typeof row?.['allFound'] !== 'boolean') {
    throw new Error('Invalid assistant thread bulk mutation result.');
  }
  if (!row['allFound']) {
    throw new Error('One or more assistant threads do not exist.');
  }
}
