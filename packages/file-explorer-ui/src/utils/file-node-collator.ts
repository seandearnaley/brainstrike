// Shared collator definitions used across file explorer sorting paths.
// Keep these aligned with existing localeCompare behavior where applicable.
export const defaultCollator = new Intl.Collator(undefined);

export const fileNodeCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});
