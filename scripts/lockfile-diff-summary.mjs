// A pnpm lockfile diff is generated output, and it dominates any dependency PR:
// 97% of #3029's 410 KiB and of #3037's 94 KiB, leaving 9 KiB and 2 KiB of code.
// Sending it verbatim spends the review's context on content whose reviewable
// signal is a short list of resolution changes, which the raw hunks bury under
// peer-dependency noise. This replaces those hunks with that list. It is a
// stated substitution, never a silent one: preparation names it in the prompt
// and the trusted reporter republishes it in the disposition.

const LOCKFILE = 'pnpm-lock.yaml';
const HEADER = /^diff --git a\/(\S+) b\/(\S+)$/;
// Entries in `packages:` and `snapshots:` sit at exactly two spaces and end in a
// colon. Importer paths (`apps/web:`) carry no version and fall out in
// splitPackageKey; catalog and override entries are indented deeper or carry a
// value after the colon, so neither reaches here.
const ENTRY = /^([+-]) {2}(?:'([^']+)'|([^'\s][^:]*)):$/;
const RESOLUTION = /^\+\s+resolution: \{/;
const REGISTRY_RESOLUTION = /^\+\s+resolution: \{integrity:/;

/**
 * Split `name@version` out of a lockfile key. The peer suffix carries its own
 * '@' — `@codemirror/view@6.1.0(@codemirror/state@6.5.2)` — so a bare
 * lastIndexOf('@') reads the peer's version as the package's. That mistake has
 * produced a false green in this repository before.
 */
export function splitPackageKey(key) {
  const bare = key.includes('(') ? key.slice(0, key.indexOf('(')) : key;
  const at = bare.lastIndexOf('@');
  if (at <= 0 || at === bare.length - 1) {
    return null;
  }
  return { name: bare.slice(0, at), version: bare.slice(at + 1) };
}

function collect(section) {
  const added = new Map();
  const removed = new Map();
  const foreign = [];
  for (const line of section) {
    const entry = ENTRY.exec(line);
    if (entry) {
      const parsed = splitPackageKey(entry[2] ?? entry[3]);
      if (parsed) {
        const into = entry[1] === '+' ? added : removed;
        const versions = into.get(parsed.name) ?? new Set();
        versions.add(parsed.version);
        into.set(parsed.name, versions);
      }
      continue;
    }
    // A resolution that is not an integrity hash points somewhere other than the
    // registry — a tarball, git, or directory source. There are none in this
    // tree, so one appearing is worth naming rather than counting.
    if (RESOLUTION.test(line) && !REGISTRY_RESOLUTION.test(line)) {
      foreign.push(line.replace(/^\+\s*/, ''));
    }
  }
  return { added, foreign, removed };
}

function summarizeSection(section, path) {
  const { added, foreign, removed } = collect(section);
  const names = [...new Set([...added.keys(), ...removed.keys()])].sort();
  const changes = names.map((name) => {
    const to = [...(added.get(name) ?? [])].sort();
    const from = [...(removed.get(name) ?? [])].sort();
    if (to.length && from.length) {
      return `  ${name}: ${from.join(', ')} -> ${to.join(', ')}`;
    }
    return to.length
      ? `  ${name}: added ${to.join(', ')}`
      : `  ${name}: removed ${from.join(', ')}`;
  });
  const duplicates = [...added]
    .filter(([, versions]) => versions.size > 1)
    .map(([name, versions]) => `  ${name}: ${[...versions].sort().join(', ')}`)
    .sort();
  const omitted = Buffer.byteLength(section.slice(1).join('\n'), 'utf8');
  return [
    section[0],
    `[${LOCKFILE} hunks replaced by a derived summary: ${omitted} bytes omitted]`,
    'This file is generated. Every other file in this diff is complete and unmodified.',
    'Importer specifier changes are not lost here: they mirror the package.json',
    'diffs, which are included in full. Review this summary as you would the hunks.',
    '',
    `packages changed: ${names.length}`,
    ...changes,
    '',
    `packages on more than one version among the entries this diff ADDS: ${duplicates.length}`,
    '(a lower bound: a version this diff leaves untouched does not appear in it)',
    ...duplicates,
    '',
    `non-registry resolutions introduced: ${foreign.length}`,
    ...foreign.map((line) => `  ${line}`),
    `[end of ${path} summary]`,
  ];
}

/**
 * Replace pnpm lockfile sections of a unified diff with a derived summary and
 * pass every other byte through untouched. Returns the rewritten diff and one
 * record per replaced file, which callers must surface rather than absorb.
 */
export function summarizeLockfileDiff(diff) {
  const lines = diff.split('\n');
  const out = [];
  const replacements = [];
  let index = 0;
  while (index < lines.length) {
    const header = HEADER.exec(lines[index]);
    // Anything this does not recognise as a file header passes through, so an
    // unparsed path can only ever mean "not summarized", never "summarized wrong".
    if (!header || header[2].split('/').pop() !== LOCKFILE) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !lines[end].startsWith('diff --git ')) {
      end += 1;
    }
    const section = lines.slice(index, end);
    const summary = summarizeSection(section, header[2]);
    const originalBytes = Buffer.byteLength(section.join('\n'), 'utf8');
    const summaryBytes = Buffer.byteLength(summary.join('\n'), 'utf8');
    // A tiny lockfile change can summarize larger than it started. Substituting
    // there would cost bytes and lose the exact hunks, so keep the original.
    if (summaryBytes >= originalBytes) {
      out.push(...section);
      index = end;
      continue;
    }
    out.push(...summary);
    replacements.push({ originalBytes, path: header[2], summaryBytes });
    index = end;
  }
  return { diff: out.join('\n'), replacements };
}
