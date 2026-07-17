/**
 * ScannedWorkspaceSkills tests — brainstrike's implementation of Mastra's
 * `WorkspaceSkills` interface over the bounded skills scan.
 *
 * The engine serves Mastra's own `createSkillTools` (`skill` / `skill_search` /
 * `skill_read`) and `SkillsProcessor`, so its semantics must match the
 * interface contract: `get()` accepts a name OR a path (disambiguation),
 * reference/script/asset reads are containment-checked and bounded, disabled
 * skills are invisible everywhere (list/get/has/search), and `refresh()`
 * re-scans while `maybeRefresh()` only triggers the initial lazy scan.
 */

import { describe, expect, it } from 'vitest';
import {
  createScannedWorkspaceSkills,
  type SkillContentDeps,
} from '../skills/scanned-workspace-skills';
import { type SkillScanDeps, type SkillScanResult, scanSkills } from '../skills/skill-scan';

interface MemoryFs {
  dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  files: Record<string, string>;
}

function makeScanDeps(fs: MemoryFs): SkillScanDeps {
  return {
    listDir: (absDir, _containmentRoot, maxEntries) => {
      const entries = fs.dirs[absDir];
      if (!entries) {
        return null;
      }
      return {
        entries: entries.slice(0, maxEntries).map((entry) => ({
          isDirectory: entry.kind === 'dir',
          isFile: entry.kind === 'file',
          name: entry.name,
        })),
        inspected: Math.min(entries.length, maxEntries),
        truncated: entries.length > maxEntries,
      };
    },
    readFile: (absFile) =>
      absFile in fs.files
        ? { content: fs.files[absFile] as string, ok: true }
        : { ok: false, reason: 'unreadable' },
  };
}

function makeContentDeps(fs: MemoryFs): SkillContentDeps {
  const scan = makeScanDeps(fs);
  return {
    listDir: scan.listDir,
    readFileBytes: (absFile) =>
      absFile in fs.files
        ? { content: new TextEncoder().encode(fs.files[absFile] as string), ok: true }
        : { ok: false, reason: 'unreadable' },
    readFileText: scan.readFile,
  };
}

const SKILLS_DIR = '/proj/a/.brainstrike/skills';

function fixtureFs(): MemoryFs {
  return {
    dirs: {
      [SKILLS_DIR]: [
        { kind: 'dir', name: 'pdf-processing' },
        { kind: 'dir', name: 'code-review' },
      ],
      [`${SKILLS_DIR}/code-review`]: [{ kind: 'file', name: 'SKILL.md' }],
      [`${SKILLS_DIR}/pdf-processing`]: [
        { kind: 'file', name: 'SKILL.md' },
        { kind: 'dir', name: 'references' },
        { kind: 'dir', name: 'scripts' },
      ],
      [`${SKILLS_DIR}/pdf-processing/references`]: [
        { kind: 'file', name: 'forms.md' },
        { kind: 'dir', name: 'guides' },
      ],
      [`${SKILLS_DIR}/pdf-processing/references/guides`]: [{ kind: 'file', name: 'deep.md' }],
      [`${SKILLS_DIR}/pdf-processing/scripts`]: [{ kind: 'file', name: 'fill.py' }],
    },
    files: {
      [`${SKILLS_DIR}/code-review`.concat('/SKILL.md')]:
        '---\nname: code-review\ndescription: Review code changes carefully.\n---\nCheck correctness and style.',
      [`${SKILLS_DIR}/pdf-processing/SKILL.md`]:
        '---\nname: pdf-processing\ndescription: Extract text from PDF files.\n---\nUse pdfplumber to extract text.\nSee references/forms.md for forms.',
      [`${SKILLS_DIR}/pdf-processing/references/forms.md`]: '# Forms guide\nAcroForm details here.',
      [`${SKILLS_DIR}/pdf-processing/references/guides/deep.md`]: 'Nested guide content.',
      [`${SKILLS_DIR}/pdf-processing/scripts/fill.py`]: 'print("fill")',
    },
  };
}

function makeEngine(
  fs: MemoryFs,
  options: { isEnabled?: (skill: { preferenceKey: string }) => boolean } = {}
) {
  let scanCount = 0;
  const engine = createScannedWorkspaceSkills({
    deps: makeContentDeps(fs),
    ...(options.isEnabled ? { isEnabled: options.isEnabled } : {}),
    scan: (): SkillScanResult => {
      scanCount += 1;
      return scanSkills(
        { homeDir: '/home/user', roots: [{ absPath: '/proj/a', displayName: 'A', id: 'root-a' }] },
        makeScanDeps(fs)
      );
    },
  });
  return { engine, scans: () => scanCount };
}

describe('ScannedWorkspaceSkills list/get/has', () => {
  it('lists skill metadata (Agent Skills spec fields) for every enabled skill', async () => {
    const { engine } = makeEngine(fixtureFs());
    const list = await engine.list();
    expect(list.map((skill) => skill.name).sort()).toEqual(['code-review', 'pdf-processing']);
    const pdf = list.find((skill) => skill.name === 'pdf-processing');
    expect(pdf).toMatchObject({
      description: 'Extract text from PDF files.',
      path: `${SKILLS_DIR}/pdf-processing`,
    });
  });

  it('gets a full skill by name with instructions and discovered reference/script/asset listings', async () => {
    const { engine } = makeEngine(fixtureFs());
    const skill = await engine.get('pdf-processing');
    expect(skill).not.toBeNull();
    expect(skill?.instructions).toContain('Use pdfplumber');
    expect(skill?.references.sort()).toEqual(['forms.md', 'guides/deep.md']);
    expect(skill?.scripts).toEqual(['fill.py']);
    expect(skill?.assets).toEqual([]);
  });

  it('gets a skill by its directory path (disambiguation contract)', async () => {
    const { engine } = makeEngine(fixtureFs());
    const skill = await engine.get(`${SKILLS_DIR}/pdf-processing`);
    expect(skill?.name).toBe('pdf-processing');
  });

  it('accepts a path with a trailing /SKILL.md suffix (SkillsProcessor formats locations that way)', async () => {
    const { engine } = makeEngine(fixtureFs());
    const skill = await engine.get(`${SKILLS_DIR}/pdf-processing/SKILL.md`);
    expect(skill?.name).toBe('pdf-processing');
  });

  it('returns null / false for unknown skills', async () => {
    const { engine } = makeEngine(fixtureFs());
    expect(await engine.get('nope')).toBeNull();
    expect(await engine.has('nope')).toBe(false);
    expect(await engine.has('code-review')).toBe(true);
  });
});

describe('ScannedWorkspaceSkills preference filtering', () => {
  it('hides disabled skills from list/get/has/search', async () => {
    const { engine } = makeEngine(fixtureFs(), {
      isEnabled: (skill) => skill.preferenceKey !== 'root:root-a:pdf-processing',
    });
    expect((await engine.list()).map((skill) => skill.name)).toEqual(['code-review']);
    expect(await engine.get('pdf-processing')).toBeNull();
    expect(await engine.has('pdf-processing')).toBe(false);
    const results = await engine.search('pdfplumber');
    expect(results).toEqual([]);
  });
});

describe('ScannedWorkspaceSkills reference/script/asset access', () => {
  it('reads a reference file (by skill name and by skill path)', async () => {
    const { engine } = makeEngine(fixtureFs());
    expect(await engine.getReference('pdf-processing', 'forms.md')).toContain('AcroForm');
    expect(await engine.getReference(`${SKILLS_DIR}/pdf-processing`, 'guides/deep.md')).toContain(
      'Nested guide'
    );
  });

  it('reads scripts as text and assets as bytes', async () => {
    const { engine } = makeEngine(fixtureFs());
    expect(await engine.getScript('pdf-processing', 'fill.py')).toBe('print("fill")');
    expect(await engine.getAsset('pdf-processing', 'missing.png')).toBeNull();
  });

  it('refuses path traversal and absolute paths (containment, never escapes the skill dir)', async () => {
    const { engine } = makeEngine(fixtureFs());
    expect(await engine.getReference('pdf-processing', '../code-review/SKILL.md')).toBeNull();
    expect(await engine.getReference('pdf-processing', '/etc/passwd')).toBeNull();
    expect(await engine.getScript('pdf-processing', '..%2F..')).toBeNull();
  });

  it('lists references (nested), scripts, and assets', async () => {
    const { engine } = makeEngine(fixtureFs());
    expect((await engine.listReferences('pdf-processing')).sort()).toEqual([
      'forms.md',
      'guides/deep.md',
    ]);
    expect(await engine.listScripts('pdf-processing')).toEqual(['fill.py']);
    expect(await engine.listAssets('pdf-processing')).toEqual([]);
    expect(await engine.listReferences('code-review')).toEqual([]);
  });
});

describe('ScannedWorkspaceSkills search', () => {
  it('finds matches in SKILL.md instructions with line ranges and honest sources', async () => {
    const { engine } = makeEngine(fixtureFs());
    const results = await engine.search('pdfplumber');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      skillName: 'pdf-processing',
      skillPath: `${SKILLS_DIR}/pdf-processing`,
      source: 'SKILL.md',
    });
    expect(results[0]?.content).toContain('pdfplumber');
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it('searches reference files by default and can be scoped by skillNames', async () => {
    const { engine } = makeEngine(fixtureFs());
    const results = await engine.search('AcroForm');
    expect(results[0]?.source).toBe('references/forms.md');

    const scoped = await engine.search('AcroForm', { skillNames: ['code-review'] });
    expect(scoped).toEqual([]);

    const noRefs = await engine.search('AcroForm', { includeReferences: false });
    expect(noRefs).toEqual([]);
  });

  it('honors topK', async () => {
    const { engine } = makeEngine(fixtureFs());
    const results = await engine.search('the', { topK: 1 });
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('ScannedWorkspaceSkills refresh semantics', () => {
  it('scans lazily once across list/get/search; refresh() forces a re-scan', async () => {
    const fs = fixtureFs();
    const { engine, scans } = makeEngine(fs);
    await engine.list();
    await engine.get('pdf-processing');
    await engine.search('text');
    await engine.maybeRefresh();
    expect(scans()).toBe(1);

    fs.dirs[SKILLS_DIR] = [...(fs.dirs[SKILLS_DIR] ?? []), { kind: 'dir', name: 'newcomer' }];
    fs.dirs[`${SKILLS_DIR}/newcomer`] = [{ kind: 'file', name: 'SKILL.md' }];
    fs.files[`${SKILLS_DIR}/newcomer/SKILL.md`] =
      '---\nname: newcomer\ndescription: Fresh skill.\n---\nHello.';

    await engine.refresh();
    expect(scans()).toBe(2);
    expect(await engine.has('newcomer')).toBe(true);
  });
});
