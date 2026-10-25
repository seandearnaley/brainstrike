/**
 * Loads the chunks the shipped conversation imports lazily, once per browser
 * test file and before its first test.
 *
 * Assistant text renders through the markdown chunk ("Loading message…" until
 * it lands) and code blocks through Shiki's highlighter (its wasm and every
 * grammar). Whichever test met them cold paid for Vite transforming and the
 * page evaluating the whole graph inside its own timeout: on a loaded machine
 * the first keypress of a file waited about 4 s for the markdown chunk, and the
 * first test of each file ran 4-6x its unloaded time while the rest ran 2-3x.
 *
 * The hook runs after the test file's own imports, so suites that install
 * React instrumentation before react-dom loads still do so first.
 */
import { beforeAll } from 'vitest';

beforeAll(async () => {
  const [{ preloadMarkdownText }, { preloadShikiHighlighter }] = await Promise.all([
    import('../assistant-message-text'),
    import('@brainstrike/ui/code-block'),
  ]);
  await Promise.all([preloadMarkdownText(), preloadShikiHighlighter()]);
});
