/** ADR-0011 as a generated property, part 4 of 4 of the generated conversations. */
import { test } from 'vitest';
import { checkGeneratedConversations } from './fixtures/host-conversation-scenario.ts';

test('a generated conversation sends each run its path and reads the same before and after each reopen (part 4 of 4)', async () => {
  await checkGeneratedConversations();
});
