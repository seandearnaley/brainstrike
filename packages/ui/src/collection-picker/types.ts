/**
 * Collection data structure for the picker.
 *
 * This type is compatible with CollectionWithDocCount from @brainstrike/vector-management
 * to allow easy integration without type mapping.
 */
export type CollectionPickerSystemRole = 'workspace-index';

export interface CollectionPickerCollection {
  /** Whether normal users may delete this collection. Defaults to false for system collections. */
  canDelete?: boolean;
  /** Whether normal users may edit this collection. Defaults to false for system collections. */
  canEdit?: boolean;
  /** Whether manual imports may target this collection. Defaults to false for system collections. */
  canManualImport?: boolean;
  /** Whether normal search collection selectors may select this collection. */
  canNormalSearchSelect?: boolean;
  /** Collection category (optional) */
  category: string | null;
  /** Number of chunks */
  chunkCount: number;
  /** ISO timestamp of collection creation */
  createdAt: string;
  /** Collection description (optional) */
  description: string | null;
  /** Embedding dimensions (e.g., 1536) */
  dimensions: number;
  /** Human-readable reason when selection is disabled. */
  disabledReason?: string | null;
  /** Distance metric for similarity search */
  distance: 'cosine' | 'l2' | 'ip';
  /** Number of embeddings generated */
  embeddingCount: number;
  /** Number of files imported into this collection */
  fileCount: number;
  /** Unique collection identifier */
  id: string;
  /** Model ID without provider prefix */
  modelId: string;
  /** Full model key (e.g., "openai::text-embedding-3-small") */
  modelKey: string;
  /** User-friendly name (optional) */
  name: string | null;
  /** Whether this row is managed by Brainstrike rather than the user. */
  systemManaged?: boolean;
  /** Durable system role for protected Brainstrike-owned collections. */
  systemRole?: CollectionPickerSystemRole | null;
  /** Comma-separated tags (optional) */
  tags: string | null;
}

/**
 * Props for the CollectionPicker component.
 */
export interface CollectionPickerProps {
  /** Additional className */
  className?: string;
  /** List of collections to display */
  collections: CollectionPickerCollection[];

  /** Custom empty state component */
  emptyState?: React.ReactNode;

  /** Label text for the header */
  headerLabel?: string;

  /** Loading state */
  loading?: boolean;

  /** Maximum height for the scrollable area (default: 280px) */
  maxHeight?: string;

  /** Callback when create button is clicked */
  onCreate: () => void;

  /** Callback when delete is clicked on a collection */
  onDelete: (collection: CollectionPickerCollection) => void;

  /** Callback when edit is clicked on a collection */
  onEdit: (collection: CollectionPickerCollection) => void;

  /** Callback when a collection is selected (click to select, click again to deselect) */
  onSelect: (id: string | null) => void;

  /** Currently selected collection ID */
  selectedId: string | null;

  /** Whether to show the header with label and create button */
  showHeader?: boolean;
}

/**
 * Props for the CollectionPickerItem component.
 */
export interface CollectionPickerItemProps {
  /** Collection data */
  collection: CollectionPickerCollection;

  /** Unique ID for accessibility */
  id?: string;

  /** Whether this collection currently has keyboard focus */
  isFocused?: boolean;

  /** Whether this collection is currently selected */
  isSelected: boolean;

  /** Callback when delete button is clicked */
  onDelete: (collection: CollectionPickerCollection) => void;

  /** Callback when edit button is clicked */
  onEdit: (collection: CollectionPickerCollection) => void;

  /** Callback when this collection is clicked */
  onSelect: (id: string) => void;
}

/**
 * Props for the CollectionPickerHeader component.
 */
export interface CollectionPickerHeaderProps {
  /** Header label text */
  label: string;

  /** Callback when create button is clicked */
  onCreate: () => void;

  /** Whether to show the label (default: true) */
  showLabel?: boolean;
}

/**
 * Props for the CollectionPickerEmpty component.
 */
export interface CollectionPickerEmptyProps {
  /** Callback when create button is clicked */
  onCreate: () => void;
}
