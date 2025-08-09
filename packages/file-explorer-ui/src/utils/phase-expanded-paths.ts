import type { IFileNode } from '@brainstrike/types';

export interface PhaseExpansionOptions {
  initialCap: number;
  chunkSize: number;
  delayMs: number;
}

export interface PhaseExpandedPathsParams {
  fileTree: IFileNode[];
  originalExpanded: ReadonlySet<string> | undefined | null;
  setExpandedPaths: (paths: ReadonlySet<string>) => void;
  getExpandedPaths: () => ReadonlySet<string>;
  applyExpandedPaths: (paths: ReadonlySet<string>) => void;
  schedule?: (cb: () => void) => void;
  options?: Partial<PhaseExpansionOptions>;
}

const defaultOptions: PhaseExpansionOptions = {
  // Tuned for responsiveness on Electron restores
  initialCap: 40,
  chunkSize: 16,
  delayMs: 50,
};

function* bfsDirectories(tree: IFileNode[]): Generator<IFileNode> {
  const queue: IFileNode[] = [];
  for (const n of tree) if (n.type === 'directory') queue.push(n);
  while (queue.length > 0) {
    const d = queue.shift();
    if (!d) break;
    yield d;
    if (d.children) {
      for (const c of d.children) if (c.type === 'directory') queue.push(c);
    }
  }
}

function computeInitialSubset(
  tree: IFileNode[],
  expanded: ReadonlySet<string>,
  max: number
): string[] {
  const subset: string[] = [];
  for (const d of bfsDirectories(tree)) {
    if (expanded.has(d.path)) subset.push(d.path);
    if (subset.length >= max) break;
  }
  return subset;
}

export function phaseExpandedPaths(params: PhaseExpandedPathsParams): void {
  const opts = { ...defaultOptions, ...(params.options ?? {}) };
  if (!shouldPhase(params.originalExpanded, opts.initialCap)) return;

  const { subset, remaining } = computeSubsetAndRemaining(
    params.fileTree,
    params.originalExpanded as ReadonlySet<string>,
    opts.initialCap
  );

  // Apply initial subset
  params.setExpandedPaths(new Set(subset));

  // Choose scheduler and schedule remaining
  const sched = params.schedule ?? ((cb: () => void) => setTimeout(cb, opts.delayMs));
  scheduleChunks(
    remaining,
    opts.chunkSize,
    sched,
    params.getExpandedPaths,
    params.applyExpandedPaths
  );
}

function buildRemainingList(originalExpanded: ReadonlySet<string>, subset: string[]): string[] {
  const subsetSet = new Set(subset);
  const remaining: string[] = [];
  for (const p of originalExpanded) if (!subsetSet.has(p)) remaining.push(p);
  return remaining;
}

function shouldPhase(
  originalExpanded: ReadonlySet<string> | undefined | null,
  initialCap: number
): boolean {
  if (!originalExpanded || originalExpanded.size === 0) return false;
  if (originalExpanded.size <= initialCap) return false;
  return true;
}

function computeSubsetAndRemaining(
  fileTree: IFileNode[],
  originalExpanded: ReadonlySet<string>,
  initialCap: number
): { subset: string[]; remaining: string[] } {
  const subset = computeInitialSubset(fileTree, originalExpanded, initialCap);
  const remaining = buildRemainingList(originalExpanded, subset);
  return { subset, remaining };
}

function scheduleChunks(
  remaining: string[],
  chunkSize: number,
  schedule: (cb: () => void) => void,
  getExpandedPaths: () => ReadonlySet<string>,
  applyExpandedPaths: (paths: ReadonlySet<string>) => void
): void {
  let index = 0;
  function applyNextChunk(): void {
    const slice = remaining.slice(index, index + chunkSize);
    index += chunkSize;
    if (slice.length === 0) return;
    const current = getExpandedPaths();
    const next = new Set(current);
    for (const p of slice) next.add(p);
    applyExpandedPaths(next);
    if (index < remaining.length) schedule(applyNextChunk);
  }
  schedule(applyNextChunk);
}
