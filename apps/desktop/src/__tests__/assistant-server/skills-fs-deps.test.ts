// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createSecureSkillsFs } from '../../assistant-server/skills-fs-deps';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'bs-skills-floor-'));
  const references = path.join(root, '.brainstrike/skills/release/references');
  await mkdir(references, { recursive: true });
  await writeFile(path.join(references, 'notes.md'), 'Release steps\n');
  await writeFile(path.join(references, '.env.local'), 'TYPESAFE_API_KEY=sk-live-SECRET\n');
  await writeFile(path.join(references, 'deploy.PEM'), 'PRIVATE-KEY-SECRET\n');
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

// Codex review on #3718: skill_search and skill_read read a skill's files
// through this surface, so a credential file inside a skill directory reached
// the model. The floor holds here too: never listed, never read.
it('never lists or reads a credential file inside a skill', () => {
  const skills = createSecureSkillsFs([root]);
  const references = path.join(root, '.brainstrike/skills/release/references');

  const listed = skills.listDir(references, root, 50);
  expect(listed?.entries.map((entry) => entry.name)).toEqual(['notes.md']);

  for (const name of ['.env.local', 'deploy.PEM']) {
    const file = path.join(references, name);
    expect(skills.readFileText(file)).toEqual({ ok: false, reason: 'unreadable' });
    expect(skills.readFileBytes(file)).toEqual({ ok: false, reason: 'unreadable' });
  }
  expect(skills.readFileText(path.join(references, 'notes.md'))).toEqual({
    content: 'Release steps\n',
    ok: true,
  });
});
