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
// A repointed edge is a parent whose `dependencies:` now resolves to a
// different version that already existed in the lockfile. Neither end is an
// added or removed entry, so the entry lists above are structurally blind to
// it — which is exactly the shape of a dedupe or a security lift. #3053 lifted
// undici 7.28.0 -> 7.29.1 that way and the summary could only show unrelated
// 6.28.1/8.10.2 additions, reading as the subtree leaving the 7.x line.
//
// Resolved edges sit at six spaces inside `snapshots:`. The section is what
// scopes them, not the enclosing `dependencies:` key: with -U3 a block key four
// lines above a changed edge falls outside the hunk, and #3053's flagship hunk
// carried neither its key nor its `dependencies:` line. Section is recoverable
// where those are not, because git's funcname trailer names the nearest
// column-0 line and a lockfile's are exactly its section markers. Scoping by
// section is also sufficient: inside `snapshots:` every six-space `name: value`
// line is a resolved edge, since `transitivePeerDependencies` emits only
// `- item` list entries. `packages:` peerDependencies sit at the same depth but
// hold ranges, so they must not be read as resolutions.
const HUNK = /^@@ [^@]*@@ ?(.*)$/;
const SECTION = /^([A-Za-z_$][\w.-]*):\s*$/;
const BLOCK = /^ {2}(?:'([^']+)'|([^'\s][^:]*)):$/;
const EDGE = /^ {6}(?:'([^']+)'|([^'\s][^:]*)): (\S.*)$/;
const EDGE_SECTION = 'snapshots';
const DIFF_LINE = /^[ +-]/;
// Edges are grouped by the transition they make, which is what a reviewer asks
// about: `undici: 7.28.0 => 7.29.1 (4 edges)` settles a lift in one line where
// four separate lines only repeat themselves. It also bounds the section by
// distinct transitions rather than by edge count, so a dedupe repointing
// hundreds of edges still costs a flat handful of lines. Both axes are capped
// anyway, because a wide update can widen the transition list too.
const TRANSITIONS_LISTED = 12;
const PARENTS_LISTED = 4;

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

/**
 * Pair removed and added dependency lines within each snapshot block into
 * repointed edges. Pairing is by dependency name, never by position: a
 * positional pairing would marry an unrelated removal to an unrelated addition
 * and report a graph change that did not happen. A name on only one side is an
 * edge added or dropped outright, which the entry lists already carry.
 */
export function collectEdges(lines) {
  const edges = [];
  let unclassified = 0;
  let section = null;
  let parent = null;
  let removed = new Map();
  let added = new Map();
  // Always called before `parent` is reassigned, so pending lines are paired
  // against the block that was in scope when they were read. Reversing that
  // order shifts every attribution by one block, plausibly and silently.
  const flush = () => {
    for (const [name, from] of removed) {
      const to = added.get(name);
      if (to !== undefined && to !== from) {
        edges.push({ from, name, parent, to });
      }
    }
    removed = new Map();
    added = new Map();
  };
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      // Hunks are not contiguous, so nothing about the block in scope survives
      // one. Holding a parent across it would name the wrong package, which is
      // worse than naming none: it is confidently wrong.
      flush();
      section = SECTION.exec(hunk[1])?.[1] ?? null;
      parent = null;
      continue;
    }
    if (!DIFF_LINE.test(line)) {
      continue;
    }
    const body = line.slice(1);
    const marker = SECTION.exec(body);
    if (marker) {
      flush();
      section = marker[1];
      parent = null;
      continue;
    }
    const block = BLOCK.exec(body);
    if (block) {
      flush();
      // splitPackageKey, never a bare lastIndexOf('@'): the peer suffix on
      // `@codemirror/view@6.1.0(@codemirror/state@6.5.2)` carries its own '@'.
      parent = splitPackageKey(block[1] ?? block[2]);
      continue;
    }
    if (line[0] === ' ') {
      continue;
    }
    const edge = EDGE.exec(body);
    if (!edge) {
      continue;
    }
    // A hunk whose header named no section cannot be classified either way.
    // Dropping these while still printing a confident total would under-report
    // in silence, which is the one failure mode worth spending a line on.
    if (section === null) {
      unclassified += 1;
      continue;
    }
    if (section !== EDGE_SECTION) {
      continue;
    }
    (line[0] === '+' ? added : removed).set(edge[1] ?? edge[2], edge[3]);
  }
  flush();
  return { edges, unclassified };
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

// Package identifiers are ASCII, and code-unit order is the same everywhere.
// localeCompare without an explicit locale follows the runtime's ICU data, so a
// small-icu build would cut the capped list differently — and the parent roll
// below already sorts by code unit, so the two would disagree.
const byKey = (a, b) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/**
 * Render repointed edges grouped by the version transition they make. Parents
 * are named where the diff showed a block key and counted where it did not:
 * silence about a parent is honest, while borrowing one from another block
 * would be confidently wrong.
 */
function summarizeEdges({ edges, unclassified }) {
  // Qualifies the headline count, so it sits under the headline. Trailing the
  // transition list at the same indent, it read as one more transition entry.
  const skipped = unclassified
    ? [
        `(a lower bound: ${plural(unclassified, 'changed dependency line')} in hunks with no section header went unclassified)`,
      ]
    : [];
  const groups = new Map();
  for (const { from, name, parent, to } of edges) {
    const key = `${name}: ${from} => ${to}`;
    const group = groups.get(key) ?? { anonymous: 0, parents: [] };
    if (parent) {
      group.parents.push(`${parent.name}@${parent.version}`);
    } else {
      group.anonymous += 1;
    }
    groups.set(key, group);
  }
  // The caveat qualifies edges, so it is only worth its bytes when there are
  // any. This section is emitted on every summary, and a summary only replaces
  // hunks it shrinks: standing prose here narrows what gets summarized at all.
  if (!groups.size) {
    return ['dependency edges repointed: 0 (snapshots only)', ...skipped];
  }
  const size = (group) => group.parents.length + group.anonymous;
  // Widest transition first: a lift or a dedupe is why this section exists, and
  // it is the one carrying the most edges.
  const ordered = [...groups].sort((a, b) => size(b[1]) - size(a[1]) || byKey(a[0], b[0]));
  const lines = ordered.slice(0, TRANSITIONS_LISTED).map(([key, group]) => {
    const named = [...group.parents].sort();
    const tail = [];
    if (named.length > PARENTS_LISTED) {
      tail.push(`and ${plural(named.length - PARENTS_LISTED, 'more parent')}`);
    }
    if (group.anonymous) {
      tail.push(`${group.anonymous} with no parent in this diff`);
    }
    const owners = [...named.slice(0, PARENTS_LISTED), ...tail].join(', ');
    return `  ${key} (${plural(size(group), 'edge')}): ${owners}`;
  });
  const rest = ordered.slice(TRANSITIONS_LISTED);
  const overflow = rest.reduce((sum, [, group]) => sum + size(group), 0);
  return [
    `dependency edges repointed: ${edges.length} across ${plural(groups.size, 'transition')}`,
    ...skipped,
    '(a parent resolving to a version this diff neither adds nor removes, so the',
    'lists above cannot show it; snapshots only, parents named only where shown)',
    ...lines,
    ...(rest.length
      ? [`  and ${plural(rest.length, 'more transition')} covering ${plural(overflow, 'edge')}`]
      : []),
  ];
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
  const edgeReport = collectEdges(section);
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
    ...summarizeEdges(edgeReport),
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
