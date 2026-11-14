/** Hunk actions against real repositories (ADR-0036), part 2 of 4 of the generated edits. */
import { it } from 'vitest';
import { checkChosenHunks } from './changeset-git-actions-test-support.ts';

it('stage, unstage and revert exactly the chosen hunks, where their text repeats (part 2 of 4)', async () => {
  await checkChosenHunks();
});
