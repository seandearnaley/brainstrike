// Main component
export { CollectionPicker } from './collection-picker';

// Sub-components (for customization if needed)
export { CollectionPickerEmpty } from './collection-picker-empty';
export { CollectionPickerHeader } from './collection-picker-header';
export { CollectionPickerItem } from './collection-picker-item';
// Hooks
export { type ResolvedTheme, useResolvedTheme } from './hooks/use-resolved-theme';
export {
  type CollectionPickerProtection,
  getCollectionPickerProtection,
} from './protection';
// Types
export type {
  CollectionPickerCollection,
  CollectionPickerEmptyProps,
  CollectionPickerHeaderProps,
  CollectionPickerItemProps,
  CollectionPickerProps,
} from './types';

// Utilities
export {
  type CollectionColorResult,
  extractProviderId,
  formatProviderLabel,
  getCollectionColor,
} from './utils/collection-colors';
