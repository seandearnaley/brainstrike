/** Identity and seeded database shared by the delegated host authority suites. */

import type { DelegatedConversationIdentity, DelegatedRunIdentity } from '@brainstrike/agent';
import { migrate, wasmLoader } from '@brainstrike/db';
import type { PGlite } from '@electric-sql/pglite';

export const scope = { ownerResourceId: 'owner', rootThreadId: 'root' };

export const identity: DelegatedConversationIdentity = {
  childResourceId: 'native-child-owner',
  childThreadId: 'child',
  configuration: { maxSteps: 16, persona: { id: 'explore' } },
  parentResourceId: 'owner',
  parentRuntimeRunId: 'parent-native-run',
  parentThreadId: 'root',
  parentToolCallId: 'parent-call',
  personaId: 'explore',
};
export const run: DelegatedRunIdentity = {
  childRuntimeRunId: 'child-native-run',
  parentRuntimeRunId: identity.parentRuntimeRunId,
  parentToolCallId: identity.parentToolCallId,
  personaId: identity.personaId,
};

/** A migrated database seeded with the roots, children and host legs. */
export async function createHostDatabase(name: string): Promise<PGlite> {
  const database = await wasmLoader.createPGlite(name);
  await migrate(database);
  await migrate(database);
  await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, metadata, "createdAt", "updatedAt") VALUES
      ('root', 'owner', 'Root', '{}', NOW(), NOW()),
      ('other', 'owner', 'Other root', '{}', NOW(), NOW()),
      ('child', 'native-child-owner', 'Child', '{}', NOW(), NOW()),
      ('sibling', 'native-sibling-owner', 'Sibling', '{}', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at, turn_message_id) VALUES
      ('initial-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('resume-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn'),
      ('other-turn-leg', 'owner', 'root', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'other-turn'),
      ('other-root-leg', 'owner', 'other', 'openai', 'test', 'desktop', 'running',
       NOW(), NOW(), NOW(), 'user-turn');`);
  return database;
}
