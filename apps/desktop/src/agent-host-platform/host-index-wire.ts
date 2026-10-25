/**
 * ADR-0029 stage 4: the agent host runs the workspace index; Main keeps the embedding renderer
 * it lends the index and the assistant preferences that name a local runtime's URL.
 */
/** Main's embedding Stop: the host pauses the index, then asks Main to stop the renderer. */
export const HOST_INDEX_EMBEDDING_STOP = 'host/index/embedding-stop';
/** Stops Main's embedding renderer, once the index's own inference is cancelled. */
export const PLATFORM_EMBEDDING_STOP = 'platform/embedding/stop';
/** The serialized assistant preferences, or null: a hosted local runtime's configured URL. */
export const PLATFORM_RUNTIME_PREFERENCES_READ = 'platform/runtime-preferences/read';
