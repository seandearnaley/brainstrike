import path from 'node:path';
import type { WorkspaceFileNode } from '@brainstrike/agent-host/protocol';
import { AccessError, getTestDirectoryStructure } from '@brainstrike/file-system';
import { type E2eFileSystemFixture, readE2eFileSystemFixture } from '../e2e-file-system-fixture';

/**
 * The e2e mock tree lives under the host's own `/mock`, so on Windows it is
 * `C:\mock\...` with `\` separators: the shape a real folder has there, which
 * the renderer must handle and which `path.normalize` leaves unchanged.
 */
const MOCK_PATH_PREFIX = `${path.resolve('/mock')}${path.sep}`;
export const MOCK_ROOT_PATH = path.resolve('/mock/test/directory');
const MOCK_FILE_CONTENT = 'Mock file content for testing purposes\nThis is a test file.\n';

/**
 * The folders a desktop E2E launch serves from memory instead of the disk: the fixture
 * the current test wrote into its profile, else the default mock tree under `/mock`.
 * Only a launch whose options name the fixture file builds one.
 */
export interface E2eSyntheticFiles {
  exists(requestedPath: string): Promise<boolean>;
  /** True when the path belongs to the mock file system and must never touch the disk. */
  owns(requestedPath: string): Promise<boolean>;
  readDirectory(directoryPath: string): Promise<readonly WorkspaceFileNode[]>;
  readFile(filePath: string): Promise<string | undefined>;
}

/**
 * The registry presents a mounted root as `path.normalize` spells it, `\mock\…`
 * on Windows, so the mock prefix is matched in that spelling too.
 */
function hasMockPathPrefix(requestedPath: string): boolean {
  return path.normalize(requestedPath).startsWith(path.normalize(MOCK_PATH_PREFIX));
}

function inFixture(fixture: E2eFileSystemFixture, requestedPath: string): boolean {
  return (
    requestedPath === fixture.rootHandle.path ||
    requestedPath in fixture.directoriesByPath ||
    requestedPath in fixture.fileContentsByPath
  );
}

/** The default mock tree, without the ids the shared test data carries for the browser lane. */
function mockDirectory(): readonly WorkspaceFileNode[] {
  const strip = (nodes: ReturnType<typeof getTestDirectoryStructure>): WorkspaceFileNode[] =>
    nodes.map(({ children, handle: { id: _id, ...handle }, ...node }) => {
      const wireHandle =
        handle.kind === 'file'
          ? { ...handle, kind: 'file' as const }
          : { ...handle, kind: 'directory' as const };
      return { ...node, handle: wireHandle, ...(children ? { children: strip(children) } : {}) };
    });
  return strip(getTestDirectoryStructure(MOCK_ROOT_PATH));
}

export function createE2eSyntheticFiles(fixturePath: string): E2eSyntheticFiles {
  // Re-read each time: a test writes its fixture after the app is already running.
  const fixture = (): Promise<E2eFileSystemFixture | null> => readE2eFileSystemFixture(fixturePath);
  return {
    exists: async (requestedPath) => {
      const current = await fixture();
      return current ? inFixture(current, requestedPath) : hasMockPathPrefix(requestedPath);
    },
    owns: async (requestedPath) => {
      const current = await fixture();
      return (
        (current !== null && inFixture(current, requestedPath)) || hasMockPathPrefix(requestedPath)
      );
    },
    readDirectory: async (directoryPath) => {
      const current = await fixture();
      if (!current) {
        return mockDirectory();
      }
      if (current.directoryReadDelayMs) {
        // A memory-served read resolves in microseconds, too fast for a Playwright step to
        // land inside a cancellable traversal; the fixture opts in to a slower one.
        await new Promise((resolve) => setTimeout(resolve, current.directoryReadDelayMs));
      }
      const entries = current.directoriesByPath[directoryPath];
      if (!entries) {
        throw new AccessError(
          `Failed to read directory: no E2E fixture registered for ${directoryPath}`,
          directoryPath,
          'read'
        );
      }
      return entries;
    },
    readFile: async (filePath) => {
      const current = await fixture();
      return current ? current.fileContentsByPath[filePath] : MOCK_FILE_CONTENT;
    },
  };
}
