import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeFileMentionId,
  type RuntimeData,
  serializeFileMentionDirective,
} from '@brainstrike/agent';
import { afterEach, expect, it } from 'vitest';
import { createDesktopDelegatedInputContext } from '../../assistant-server/delegated-input-context';
import { prepareRequestSkills } from '../../assistant-server/request-skills';
import { createSecureSkillsFs } from '../../assistant-server/skills-fs-deps';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});
const configuration = {
  maxSteps: 8,
  persona: {
    allowedToolIds: ['brainstrike.readWorkspaceFile'],
    description: 'Reads context',
    id: 'explorer',
    instructions: 'Inspect',
    label: 'Explorer',
    maxSteps: 8,
    mode: 'read-only',
  },
};
it('reads only the authenticated workspace and stores file context separately from user authorship', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bst-child-context-'));
  temporaryRoots.push(root);
  await writeFile(join(root, 'evidence.txt'), 'CHILD_WORKSPACE_EVIDENCE');
  const runtime: RuntimeData = {
    model: 'gpt-4o',
    provider: 'openai',
    workspaceRoots: [{ displayName: 'Workspace', path: root, rootId: root }],
  };
  const text = serializeFileMentionDirective({
    id: encodeFileMentionId(root, 'evidence.txt'),
    label: 'evidence.txt',
  });
  const prepare = createDesktopDelegatedInputContext(runtime);
  const context = await prepare({ id: 'human-input', text }, configuration);
  expect(context).toEqual([
    expect.objectContaining({
      content: expect.stringContaining('CHILD_WORKSPACE_EVIDENCE'),
      role: 'system',
    }),
  ]);
  expect(text).not.toContain('CHILD_WORKSPACE_EVIDENCE');
  const foreignText = serializeFileMentionDirective({
    id: encodeFileMentionId('/foreign-root', 'evidence.txt'),
    label: 'evidence.txt',
  });
  const foreign = await prepare({ id: 'foreign-input', text: foreignText }, configuration);
  expect(JSON.stringify(foreign)).not.toContain('CHILD_WORKSPACE_EVIDENCE');
  expect(JSON.stringify(foreign)).toMatch(/not.*open|not.*available|could not read/i);
  expect(await prepare({ id: 'plain-input', text: 'Next task' }, configuration)).toEqual([]);
});
it('uses the admitted child model override rather than the current parent image capability', async () => {
  const input = {
    attachments: [
      { data: 'data:image/png;base64,AQID', mediaType: 'image/png', type: 'file' as const },
    ],
    id: 'image-only',
    text: '',
  };
  const visionChild = {
    ...configuration,
    persona: { ...configuration.persona, model: { modelId: 'gpt-4o', provider: 'openai' } },
  };
  const textParent = createDesktopDelegatedInputContext({
    model: 'z-ai/glm-5.3',
    provider: 'openrouter',
  });
  await expect(textParent(input, visionChild)).resolves.toEqual([]);
  await expect(textParent(input, configuration)).rejects.toThrow('does not support image');
  const visionParent = createDesktopDelegatedInputContext({ model: 'gpt-4o', provider: 'openai' });
  await expect(
    visionParent(input, {
      ...configuration,
      persona: {
        ...configuration.persona,
        model: { modelId: 'z-ai/glm-5.3', provider: 'openrouter' },
      },
    })
  ).rejects.toThrow('does not support image');
});

it('activates a slash-selected skill through the same host-owned secure engine as a root turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bst-child-skill-'));
  temporaryRoots.push(root);
  const skillPath = join(root, '.brainstrike', 'skills', 'child-proof');
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    join(skillPath, 'SKILL.md'),
    '---\nname: child-proof\ndescription: Read child evidence.\n---\nCHILD_SKILL_INSTRUCTIONS'
  );
  const runtime: RuntimeData = {
    model: 'gpt-4o',
    provider: 'openai',
    skillsPreference: { disabledSkillKeys: [], masterEnabled: true },
    workspaceRoots: [{ displayName: 'Workspace', path: root, rootId: root }],
  };
  const { workspaceSkills } = prepareRequestSkills({
    fs: createSecureSkillsFs([root]),
    homedir: () => root,
    runtimeData: runtime,
  });
  if (!workspaceSkills) {
    throw new Error('Expected enabled host skills engine');
  }
  const input = { id: 'skill-input', text: ':skill[child-proof]' };
  const context = await createDesktopDelegatedInputContext({ ...runtime, workspaceSkills })(
    input,
    configuration
  );
  expect(context).toEqual([
    expect.objectContaining({
      content: expect.stringContaining('CHILD_SKILL_INSTRUCTIONS'),
      role: 'system',
    }),
  ]);
  expect(input.text).toBe(':skill[child-proof]');
  expect(await createDesktopDelegatedInputContext(runtime)(input, configuration)).toEqual([]);
});
