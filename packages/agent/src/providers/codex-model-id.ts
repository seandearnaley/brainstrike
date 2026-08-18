/**
 * Catalog id -> Codex wire id (BST-1356).
 *
 * The model catalog stores ChatGPT-subscription models `codex/`-prefixed
 * because the `models` table's `id` is a GLOBAL primary key (migration 015):
 * a bare `gpt-5.5` row would collide with, and on upsert HIJACK, the platform
 * `openai` row of the same id. Every multi-route provider namespaces for this
 * reason (openrouter `openai/…`, bedrock `anthropic.…`).
 *
 * The Codex backend expects the BARE model id, so the prefix is stripped
 * here — the direct mirror of `resolveBedrockModelId`, where the catalog id
 * and the routed id likewise differ.
 */

export const CODEX_MODEL_ID_PREFIX = 'codex/';

/**
 * Strip the catalog prefix. An UNPREFIXED id throws rather than passing
 * through: it would happen to work against the Codex backend today, which is
 * precisely what makes a silent pass-through dangerous — the catalog and this
 * resolver would have drifted with nothing to show for it.
 */
export function resolveCodexModelId(catalogModelId: string): string {
  if (!catalogModelId.startsWith(CODEX_MODEL_ID_PREFIX)) {
    throw new Error(
      `ChatGPT-subscription model id "${catalogModelId}" is missing the required "${CODEX_MODEL_ID_PREFIX}" catalog prefix.`
    );
  }
  const wireId = catalogModelId.slice(CODEX_MODEL_ID_PREFIX.length);
  if (wireId.length === 0) {
    throw new Error(
      `ChatGPT-subscription model id "${catalogModelId}" carries no model id after the "${CODEX_MODEL_ID_PREFIX}" prefix.`
    );
  }
  return wireId;
}
