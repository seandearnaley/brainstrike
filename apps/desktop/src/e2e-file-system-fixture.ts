import { readFile } from 'node:fs/promises';
import {
  WorkspaceDirectoryHandleSchema,
  WorkspaceFileNodeSchema,
} from '@brainstrike/agent-host/protocol';
import { wireDecoder } from '@brainstrike/assistant-contract/schema-boundary';
import { Schema } from 'effect';

/**
 * The desktop E2E mock file system. A test writes this file into the profile's user-data
 * folder; Main's test-mode folder picker returns its root, and the agent host serves the
 * root's reads from it instead of the disk. Only an E2E launch names the file.
 */
const E2eFileSystemFixtureSchema = Schema.Struct({
  directoriesByPath: Schema.Record(Schema.String, Schema.Array(WorkspaceFileNodeSchema)),
  /**
   * An opt-in delay (ms) for each directory read. A memory-served read resolves in
   * microseconds, too fast for a Playwright step to land inside a cancellable traversal.
   */
  directoryReadDelayMs: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
  ),
  fileContentsByPath: Schema.Record(Schema.String, Schema.String),
  rootHandle: WorkspaceDirectoryHandleSchema,
});
export type E2eFileSystemFixture = (typeof E2eFileSystemFixtureSchema)['Type'];

export const E2E_FILE_SYSTEM_FIXTURE_FILE = 'e2e-file-system-fixture.json';

const decodeFixture = wireDecoder(E2eFileSystemFixtureSchema, {
  errors: 'all',
  onExcessProperty: 'error',
});

/** The fixture the current test wrote, or null when it wrote none. A malformed one throws. */
export async function readE2eFileSystemFixture(
  fixturePath: string
): Promise<E2eFileSystemFixture | null> {
  let text: string;
  try {
    text = await readFile(fixturePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  return decodeFixture(JSON.parse(text));
}
