/**
 * Agent Skills scanner tests (SKILL.md discovery).
 *
 * The scanner mirrors the desktop user-slash-commands loader: four location
 * tiers in PRIORITY order (highest first), first-name-wins dedupe with visible
 * `shadowed` entries, bounded reads/traversal, and fail-closed `invalid`
 * entries for malformed skills (never a silent half-parse). Validation mirrors
 * the Agent Skills spec exactly as @mastra/core enforces it (name 1–64 chars of
 * [a-z0-9-], no leading/trailing/double hyphen, name === directory name,
 * description 1–1024 chars).
 */

import { addLogListener, configureLogger, type LogRecord } from '@brainstrike/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetSkillScanWarningsForTests,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILLS,
  type SkillScanDeps,
  type SkillScanInput,
  type SkillScanRoot,
  scanSkills,
} from '../skills/skill-scan';

/** In-memory fs: `dirs` maps an absolute dir to its immediate entries; `files` maps an absolute file to its content. */
interface MemoryFs {
  readonly dirs: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>;
  readonly files: Record<string, string>;
}

function makeDeps(fs: MemoryFs): SkillScanDeps {
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

const HOME = '/home/user';
const ROOT_A: SkillScanRoot = { absPath: '/proj/a', displayName: 'A', id: 'root-a' };
const ROOT_B: SkillScanRoot = { absPath: '/proj/b', displayName: 'B', id: 'root-b' };

function skillMd(name: string, description = `Use for ${name} work.`, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\nInstructions for ${name}.\n`;
}

function scanInput(roots: readonly SkillScanRoot[] = [ROOT_A]): SkillScanInput {
  return { homeDir: HOME, roots };
}

function captureLogs(): { records: LogRecord[]; stop: () => void } {
  configureLogger({ console: false });
  const records: LogRecord[] = [];
  const stop = addLogListener((record) => records.push(record));
  return { records, stop };
}

beforeEach(() => {
  __resetSkillScanWarningsForTests();
});

afterEach(() => {
  __resetSkillScanWarningsForTests();
});

describe('scanSkills discovery', () => {
  it('discovers a valid root-scoped skill with parsed metadata and durable preference key', () => {
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'pdf-processing' }],
        '/proj/a/.brainstrike/skills/pdf-processing': [{ kind: 'file', name: 'SKILL.md' }],
      },
      files: {
        '/proj/a/.brainstrike/skills/pdf-processing/SKILL.md': skillMd(
          'pdf-processing',
          'Extract text and tables from PDF files. Use when working with PDFs.'
        ),
      },
    });

    const result = scanSkills(scanInput(), deps);

    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    if (entry?.status !== 'ok') {
      throw new Error(`expected ok entry, got ${JSON.stringify(entry)}`);
    }
    expect(entry.skill).toMatchObject({
      description: 'Extract text and tables from PDF files. Use when working with PDFs.',
      dirAbsPath: '/proj/a/.brainstrike/skills/pdf-processing',
      dirName: 'pdf-processing',
      name: 'pdf-processing',
      preferenceKey: 'root:root-a:pdf-processing',
      sourceRootId: 'root-a',
      tier: 'root-brainstrike',
      userInvocable: true,
    });
    expect(entry.skill.instructions).toContain('Instructions for pdf-processing.');
    expect(result.skills).toHaveLength(1);
  });

  it('parses optional fields: license, user-invocable false, metadata map, quoted + folded strings', () => {
    const content = [
      '---',
      'name: fancy-skill',
      'description: >-',
      '  A folded multi-line',
      '  description value.',
      'license: "Apache-2.0"',
      'user-invocable: false',
      'metadata:',
      '  author: sean',
      '  tags:',
      '    - docs',
      '---',
      'Body.',
      '',
    ].join('\n');
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'fancy-skill' }],
        '/proj/a/.brainstrike/skills/fancy-skill': [{ kind: 'file', name: 'SKILL.md' }],
      },
      files: { '/proj/a/.brainstrike/skills/fancy-skill/SKILL.md': content },
    });

    const result = scanSkills(scanInput(), deps);
    const entry = result.entries[0];
    if (entry?.status !== 'ok') {
      throw new Error(`expected ok entry, got ${JSON.stringify(entry)}`);
    }
    expect(entry.skill.description).toBe('A folded multi-line description value.');
    expect(entry.skill.license).toBe('Apache-2.0');
    expect(entry.skill.userInvocable).toBe(false);
    expect(entry.skill.metadata).toMatchObject({ author: 'sean' });
  });

  it('scans all four tiers in priority order and shadows lower-tier same-name skills', () => {
    const deps = makeDeps({
      dirs: {
        '/home/user/.brainstrike/skills': [{ kind: 'dir', name: 'review' }],
        '/home/user/.brainstrike/skills/review': [{ kind: 'file', name: 'SKILL.md' }],
        '/home/user/.claude/skills': [{ kind: 'dir', name: 'review' }],
        '/home/user/.claude/skills/review': [{ kind: 'file', name: 'SKILL.md' }],
        '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'review' }],
        '/proj/a/.brainstrike/skills/review': [{ kind: 'file', name: 'SKILL.md' }],
        '/proj/a/.claude/skills': [{ kind: 'dir', name: 'review' }],
        '/proj/a/.claude/skills/review': [{ kind: 'file', name: 'SKILL.md' }],
      },
      files: {
        '/home/user/.brainstrike/skills/review/SKILL.md': skillMd('review', 'Global brainstrike.'),
        '/home/user/.claude/skills/review/SKILL.md': skillMd('review', 'Global claude.'),
        '/proj/a/.brainstrike/skills/review/SKILL.md': skillMd('review', 'Root brainstrike.'),
        '/proj/a/.claude/skills/review/SKILL.md': skillMd('review', 'Root claude.'),
      },
    });

    const result = scanSkills(scanInput(), deps);

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe('Root brainstrike.');
    expect(result.skills[0]?.tier).toBe('root-brainstrike');

    const shadowed = result.entries.filter((entry) => entry.status === 'shadowed');
    expect(shadowed).toHaveLength(3);
    for (const entry of shadowed) {
      expect(entry.shadowedBy).toEqual({
        absPath: '/proj/a/.brainstrike/skills/review',
        tier: 'root-brainstrike',
      });
    }
  });

  it('keeps the first-mounted root on a cross-root name collision and warns once', () => {
    const { records, stop } = captureLogs();
    try {
      const deps = makeDeps({
        dirs: {
          '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'shared' }],
          '/proj/a/.brainstrike/skills/shared': [{ kind: 'file', name: 'SKILL.md' }],
          '/proj/b/.brainstrike/skills': [{ kind: 'dir', name: 'shared' }],
          '/proj/b/.brainstrike/skills/shared': [{ kind: 'file', name: 'SKILL.md' }],
        },
        files: {
          '/proj/a/.brainstrike/skills/shared/SKILL.md': skillMd('shared', 'From A.'),
          '/proj/b/.brainstrike/skills/shared/SKILL.md': skillMd('shared', 'From B.'),
        },
      });

      const first = scanSkills(scanInput([ROOT_A, ROOT_B]), deps);
      expect(first.skills).toHaveLength(1);
      expect(first.skills[0]?.sourceRootId).toBe('root-a');

      scanSkills(scanInput([ROOT_A, ROOT_B]), deps);
      const warns = records.filter(
        (record) => record.level === 'warn' && /duplicate skill/i.test(String(record.message))
      );
      expect(warns).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('ignores stray files in a skills dir and skill dirs without SKILL.md', () => {
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/skills': [
          { kind: 'file', name: 'README.md' },
          { kind: 'dir', name: 'empty-dir' },
          { kind: 'dir', name: 'good' },
        ],
        '/proj/a/.brainstrike/skills/empty-dir': [{ kind: 'file', name: 'notes.txt' }],
        '/proj/a/.brainstrike/skills/good': [{ kind: 'file', name: 'SKILL.md' }],
      },
      files: { '/proj/a/.brainstrike/skills/good/SKILL.md': skillMd('good') },
    });

    const result = scanSkills(scanInput(), deps);
    expect(result.entries).toHaveLength(1);
    expect(result.skills[0]?.name).toBe('good');
  });

  it('returns no entries when no skills directories exist', () => {
    const result = scanSkills(scanInput(), makeDeps({ dirs: {}, files: {} }));
    expect(result.entries).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});

describe('scanSkills validation (fail closed, visible errors)', () => {
  function invalidEntryFor(content: string, dirName = 'my-skill') {
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: dirName }],
        [`/proj/a/.brainstrike/skills/${dirName}`]: [{ kind: 'file', name: 'SKILL.md' }],
      },
      files: { [`/proj/a/.brainstrike/skills/${dirName}/SKILL.md`]: content },
    });
    const result = scanSkills(scanInput(), deps);
    expect(result.skills).toHaveLength(0);
    const entry = result.entries[0];
    if (entry?.status !== 'invalid') {
      throw new Error(`expected invalid entry, got ${JSON.stringify(entry)}`);
    }
    return entry;
  }

  it('rejects a name that does not match the directory name (Agent Skills spec)', () => {
    const entry = invalidEntryFor(skillMd('other-name'), 'my-skill');
    expect(entry.errors.join('\n')).toMatch(/must match directory name "my-skill"/);
  });

  it('rejects a missing description', () => {
    const entry = invalidEntryFor('---\nname: my-skill\n---\nBody.');
    expect(entry.errors.join('\n')).toMatch(/description/i);
  });

  it('rejects invalid name charset, hyphen placement, and over-long names', () => {
    expect(invalidEntryFor(skillMd('My-Skill'), 'My-Skill').errors.join('\n')).toMatch(
      /lowercase letters, numbers, and hyphens/
    );
    expect(invalidEntryFor(skillMd('-my-skill'), '-my-skill').errors.join('\n')).toMatch(
      /must not start or end with a hyphen/
    );
    expect(invalidEntryFor(skillMd('my--skill'), 'my--skill').errors.join('\n')).toMatch(
      /consecutive hyphens/
    );
    const long = 'a'.repeat(65);
    expect(invalidEntryFor(skillMd(long), long).errors.join('\n')).toMatch(/64 characters or less/);
  });

  it('rejects a description over 1024 characters', () => {
    const entry = invalidEntryFor(skillMd('my-skill', 'x'.repeat(1025)));
    expect(entry.errors.join('\n')).toMatch(/1024 characters or less/);
  });

  it('rejects a non-boolean user-invocable', () => {
    const entry = invalidEntryFor(skillMd('my-skill', 'Fine.', 'user-invocable: nope\n'));
    expect(entry.errors.join('\n')).toMatch(/user-invocable: Expected boolean/);
  });

  it('rejects a SKILL.md without YAML frontmatter', () => {
    const entry = invalidEntryFor('# Just markdown\n\nNo frontmatter here.');
    expect(entry.errors.join('\n')).toMatch(/frontmatter/i);
  });

  it('rejects malformed YAML frontmatter with a visible error', () => {
    const entry = invalidEntryFor('---\nname: [unclosed\ndescription: x\n---\nBody.');
    expect(entry.errors.length).toBeGreaterThan(0);
  });

  it('rejects an unterminated frontmatter fence', () => {
    const entry = invalidEntryFor('---\nname: my-skill\ndescription: x\nBody without close.');
    expect(entry.errors.join('\n')).toMatch(/frontmatter/i);
  });

  it('rejects an oversized SKILL.md by character cap with an honest error', () => {
    const entry = invalidEntryFor(skillMd('my-skill', 'Fine.') + 'x'.repeat(MAX_SKILL_FILE_CHARS));
    expect(entry.errors.join('\n')).toMatch(/exceeds/i);
  });

  it('reports a reader-rejected oversized file honestly (byte-cap pre-rejection)', () => {
    const deps: SkillScanDeps = {
      ...makeDeps({
        dirs: {
          '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'huge' }],
          '/proj/a/.brainstrike/skills/huge': [{ kind: 'file', name: 'SKILL.md' }],
        },
        files: {},
      }),
      readFile: () => ({ ok: false, reason: 'oversized' }),
    };
    const result = scanSkills(scanInput(), deps);
    const entry = result.entries[0];
    if (entry?.status !== 'invalid') {
      throw new Error(`expected invalid entry, got ${JSON.stringify(entry)}`);
    }
    expect(entry.errors.join('\n')).toMatch(/exceeds|oversized/i);
  });

  it('reports an unreadable SKILL.md as invalid (never silently absent)', () => {
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'ghost' }],
        '/proj/a/.brainstrike/skills/ghost': [{ kind: 'file', name: 'SKILL.md' }],
      },
      files: {},
    });
    const result = scanSkills(scanInput(), deps);
    const entry = result.entries[0];
    expect(entry?.status).toBe('invalid');
  });

  it('surfaces spec-limit warnings (long instructions) on valid skills', () => {
    const body = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
    const content = `---\nname: my-skill\ndescription: Fine.\n---\n${body}`;
    const deps = makeDeps({
      dirs: {
        '/proj/a/.brainstrike/skills': [{ kind: 'dir', name: 'my-skill' }],
        '/proj/a/.brainstrike/skills/my-skill': [{ kind: 'file', name: 'SKILL.md' }],
      },
      files: { '/proj/a/.brainstrike/skills/my-skill/SKILL.md': content },
    });
    const result = scanSkills(scanInput(), deps);
    const entry = result.entries[0];
    if (entry?.status !== 'ok') {
      throw new Error(`expected ok entry, got ${JSON.stringify(entry)}`);
    }
    expect(entry.skill.warnings.join('\n')).toMatch(/500/);
  });
});

describe('scanSkills bounds', () => {
  it('caps the number of accepted skills at MAX_SKILLS with a single warn', () => {
    const { records, stop } = captureLogs();
    try {
      const names = Array.from(
        { length: MAX_SKILLS + 5 },
        (_, i) => `skill-${String(i).padStart(3, '0')}`
      );
      const dirs: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
        '/proj/a/.brainstrike/skills': names.map((name) => ({ kind: 'dir', name })),
      };
      const files: Record<string, string> = {};
      for (const name of names) {
        dirs[`/proj/a/.brainstrike/skills/${name}`] = [{ kind: 'file', name: 'SKILL.md' }];
        files[`/proj/a/.brainstrike/skills/${name}/SKILL.md`] = skillMd(name);
      }
      const result = scanSkills(scanInput(), makeDeps({ dirs, files }));
      expect(result.skills.length).toBeLessThanOrEqual(MAX_SKILLS);
      const warns = records.filter(
        (record) => record.level === 'warn' && /cap/i.test(String(record.message))
      );
      expect(warns.length).toBe(1);
    } finally {
      stop();
    }
  });
});
