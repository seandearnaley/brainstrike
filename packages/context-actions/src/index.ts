export { createClipboardService } from './clipboard.js';
export {
  CLOSED_TAB_HISTORY_LIMIT,
  type ClosedTab,
  type ClosedTabHistory,
  createClosedTabHistory,
  NO_CLOSED_TAB_ERROR,
  placeTabAtIndex,
} from './closed-tab-history.js';
export { isAbsolutePath, toRelativePath } from './paths.js';
export {
  type ActionMenuItemDescriptor,
  type ActionRegistry,
  type CreateActionRegistryOptions,
  createActionRegistry,
  type GroupedActionMenuDescriptors,
  type GroupedActions,
} from './registry.js';
export {
  adjacentTabId,
  createTabStripActions,
  moveTabId,
  type TabCycleDirection,
  type TabMoveDirection,
  type TabStripActionOperations,
} from './tab-strip-actions.js';
export { createTestActionRegistry } from './testing.js';
export {
  type ActionGroup,
  type ActionOutcome,
  type ActionServices,
  type ActionShortcut,
  type ActionShortcutModifier,
  type AnyContextAction,
  type CapabilityKey,
  type ClipboardService,
  type ContextAction,
  type ContextTarget,
  type ContextTargetKind,
  defineContextAction,
  type FileContextIdentity,
  type PlatformFsService,
  type TargetOf,
} from './types.js';
