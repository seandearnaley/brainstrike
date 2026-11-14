// @vitest-environment node
/**
 * ADR-0032: a freshly cloned folder's AGENTS.md, skills and subagent personas
 * reach a run only once the person trusts the folder. Until then the folder is
 * still the run's to read and edit; it only steers nothing. Each case runs the
 * real admission over a real folder; only Main's reads and the host's trust
 * answer are stood in.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostRunAdmissionRequest } from '@brainstrike/agent-host';
import { DEFAULT_RUNTIME_SUBAGENT_SETTINGS } from '@brainstrike/assistant-contract';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  createDesktopRunAdmission,
  type DesktopTrustedRoots,
} from '../agent-host-platform/desktop-run-admission';
import { capturedIntent, everyRootTrusted, mainReads } from './fixtures/desktop-admission-reads';

const CONVENTIONS = 'CLONED_REPO_CONVENTIONS_7f3a';
let directory = '';
let cloned = { displayName: 'cloned-repo', path: '', rootId: 'root-cloned' };

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'bs-admission-trust-')));
  // The run scans the home directory's tiers too; give it an empty one.
  const home = join(directory, 'home');
  await mkdir(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  cloned = { ...cloned, path: join(directory, 'cloned-repo') };
  const skill = join(cloned.path, '.brainstrike', 'skills', 'cloned-skill');
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(skill, 'SKILL.md'),
    '---\nname: cloned-skill\ndescription: Shipped by the clone.\n---\nDo what the clone says.'
  );
  await mkdir(join(cloned.path, '.brainstrike', 'agents'), { recursive: true });
  await writeFile(
    join(cloned.path, '.brainstrike', 'agents', 'cloned-agent.md'),
    '---\ndescription: Shipped by the clone.\n---\nDo what the clone says.'
  );
  await writeFile(join(cloned.path, 'AGENTS.md'), `# Conventions\n${CONVENTIONS}\n`);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { force: true, recursive: true });
});

async function admit(trustedRoots: DesktopTrustedRoots) {
  const admission = createDesktopRunAdmission(
    mainReads({
      acquireWorkspace: async () => ({
        close: async () => undefined,
        revalidate: async () => undefined,
        roots: [cloned],
      }),
      liveWorkspaceRoots: async () => [cloned],
    }),
    async () => undefined,
    trustedRoots,
    // ADR-0040: these folders have no project, so no project memory.
    async () => undefined
  );
  const request: HostRunAdmissionRequest = {
    configuration: {
      ...capturedIntent({ model: 'gpt-6-sol', provider: 'openai' }),
      skillsPreference: { disabledSkillKeys: [], masterEnabled: true },
      subagents: {
        delegationEnabled: true,
        disabledPersonaIds: [],
        settings: { ...DEFAULT_RUNTIME_SUBAGENT_SETTINGS },
      },
      workspaceInstructionsPreference: { masterEnabled: true, oversizedOptInByRootId: {} },
    },
    modelId: 'openai::gpt-6-sol',
    runId: 'host-run',
    signal: new AbortController().signal,
    threadId: 'host-thread',
    workspaceBinding: {
      operatingRootDisplayName: cloned.displayName,
      operatingRootId: cloned.rootId,
      operatingRootPath: cloned.path,
    },
  };
  const selected = await admission.readConfiguration(request);
  try {
    return {
      personas: selected.delegation?.personas.map((persona) => persona.id) ?? [],
      roots: selected.nativeRuntime.workspaceRoots.map((root) => root.rootId),
      skills: selected.nativeRuntime.skills?.map((skill) => skill.name) ?? [],
      system: selected.system ?? '',
    };
  } finally {
    await selected.close();
  }
}

test('an untrusted folder mounts but contributes no instructions, skills or personas', async () => {
  const run = await admit(async () => []);

  expect(run.roots).toEqual(['root-cloned']);
  expect(run.system).not.toContain(CONVENTIONS);
  expect(run.skills).toEqual([]);
  expect(run.personas).not.toContain('cloned-agent');
});

test('once trusted, the same folder loads its instructions, skills and personas', async () => {
  const run = await admit(everyRootTrusted);

  expect(run.roots).toEqual(['root-cloned']);
  expect(run.system).toContain(CONVENTIONS);
  expect(run.skills).toEqual(['cloned-skill']);
  expect(run.personas).toContain('cloned-agent');
});
