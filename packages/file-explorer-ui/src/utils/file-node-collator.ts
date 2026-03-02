// Shared comparator settings for file/directory node name ordering.
// Keep these aligned with existing localeCompare behavior used in tree sorting.
export const fileNodeCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
