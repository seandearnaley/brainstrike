/** User-created collection and its explicit model profile; source and index owners share this ID. */
export interface CollectionRecord {
  readonly category?: string;
  readonly createdAt: string;
  readonly description?: string;
  readonly dimensions: number;
  readonly distance: 'cosine' | 'l2' | 'ip';
  readonly id: string;
  readonly modelId: string;
  readonly modelKey: string;
  readonly name?: string;
  readonly systemRole?: 'workspace-index';
  readonly tags?: string;
}
export type CollectionMetadata = Pick<
  CollectionRecord,
  'name' | 'description' | 'category' | 'tags'
>;
