import type { UseSearchEmbedderResult } from '@brainstrike/vector-management';

export type ThreadSearchEmbedder = Pick<
  UseSearchEmbedderResult,
  'embedDocumentWithRecovery' | 'embedQueryWithRecovery'
>;
