// The embedding-set-updated event contract moved to the shared browser-events
// module (BST-580); re-exported here so `@brainstrike/vector-management`'s
// consumers keep working. @deprecated — import from
// `@brainstrike/utils/browser-events` in new code.
// public API is unchanged.
export {
  dispatchEmbeddingSetUpdated,
  type EmbeddingSetEventCollection,
  type EmbeddingSetUpdatedEventDetail,
} from '@brainstrike/utils/browser-events';
