/** ADR-0011's blob collection as a model-based test, part 3 of 4 of the generated histories. */
import { test } from 'vitest';
import { checkGeneratedHistories } from './helpers/blob-gc-model.ts';

test('no named blob is ever removed, and nothing is left unnamed once collection is free (part 3 of 4)', async () => {
  await checkGeneratedHistories();
});
