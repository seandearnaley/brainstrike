/** Git's patch is the diff the user sees (ADR-0036), part 4 of 4 of the generated texts. */
import { it } from 'vitest';
import { checkPatchAgreement } from './structured-diff-patch-test-support.ts';

it('applies to the old side, counts what numstat counts, and reads the same in the view and the snapshot engine (part 4 of 4)', async () => {
  await checkPatchAgreement();
});
