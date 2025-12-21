/**
 * Collection data structure for the picker.
 *
 * This type is compatible with CollectionWithDocCount from @brainstrike/vector-management
 * to allow easy integration without type mapping.
 */
export type CollectionPickerCollection = {
  /** Unique collection identifier */
  id: string;
  /** Full model key (e.g., "openai::text-embedding-3-small") */
  modelKey: string;
  /** Model ID without provider prefix */
  modelId: string;
  /** Embedding dimensions (e.g., 1536) */
  dimensions: number;
  /** Distance metric for similarity search */
  distance: 'cosine' | 'l2' | 'ip';
  /** ISO timestamp of collection creation */
  createdAt: string;
  /** User-friendly name (optional) */
  name: string | null;
  /** Collection description (optional) */
  description: string | null;
  /** Comma-separated tags (optional) */
  tags: string | null;
  /** Collection category (optional) */
  category: string | null;
  /** Number of files imported into this collection */
  fileCount: number;
  /** Number of chunks (optional - for extended info) */
  chunkCount?: number;
};

/**
 * Props for the CollectionPicker component.
 */
export type CollectionPickerProps = {
  /** List of collections to display */
  collections: CollectionPickerCollection[];

  /** Currently selected collection ID */
  selectedId: string | null;

  /** Callback when a collection is selected (click to select, click again to deselect) */
  onSelect: (id: string | null) => void;

  /** Callback when edit is clicked on a collection */
  onEdit: (collection: CollectionPickerCollection) => void;

  /** Callback when delete is clicked on a collection */
  onDelete: (collection: CollectionPickerCollection) => void;

  /** Callback when create button is clicked */
  onCreate: () => void;

  /** Loading state */
  loading?: boolean;

  /** Custom empty state component */
  emptyState?: React.ReactNode;

  /** Maximum height for the scrollable area (default: 280px) */
  maxHeight?: string;

  /** Whether to show the header with label and create button */
  showHeader?: boolean;

  /** Label text for the header */
  headerLabel?: string;

  /** Additional className */
  className?: string;
};

/**
 * Props for the CollectionPickerItem component.
 */
export type CollectionPickerItemProps = {
  /** Collection data */
  collection: CollectionPickerCollection;

  /** Whether this collection is currently selected */
  isSelected: boolean;

  /** Callback when this collection is clicked */
  onSelect: (id: string) => void;

  /** Callback when edit button is clicked */
  onEdit: (collection: CollectionPickerCollection) => void;

  /** Callback when delete button is clicked */
  onDelete: (collection: CollectionPickerCollection) => void;
};

/**
 * Props for the CollectionPickerHeader component.
 */
export type CollectionPickerHeaderProps = {
  /** Header label text */
  label: string;

  /** Callback when create button is clicked */
  onCreate: () => void;
};

/**
 * Props for the CollectionPickerEmpty component.
 */
export type CollectionPickerEmptyProps = {
  /** Callback when create button is clicked */
  onCreate: () => void;
};
