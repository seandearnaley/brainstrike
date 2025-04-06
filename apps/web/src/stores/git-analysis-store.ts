import * as git from 'isomorphic-git';
import { create } from 'zustand';
import { BINARY_FILE_EXTENSIONS, TEXT_FILE_EXTENSIONS } from '../constants/file-explorer';
import { useGitStore } from './git-store';

const DEFAULT_DEPTH = 10;

// Define code file extensions and multiplier
const CODE_FILE_EXTENSIONS = ['.js', '.jsx'];
const CODE_MULTIPLIER = 1.5;

export interface RecentlyTouchedFile {
  path: string;
  lastCommitTimestamp: number;
  changes: number;
}

export interface HotspotData {
  path: string;
  score: number;
  changes: number;
  lastModified: number;
  totalLinesChanged: number;
}

export interface CommitRangeConfig {
  depth: number;
  startDate?: Date;
  endDate?: Date;
  usePartial: boolean; // existing param
}

export interface GitAnalysisState {
  recentlyTouchedFiles: RecentlyTouchedFile[];
  hotspotData: HotspotData[];
  commitRangeConfig: CommitRangeConfig;
  isAnalyzing: boolean;
  error: string | null;

  setCommitRangeConfig: (config: Partial<CommitRangeConfig>) => void;
  analyzeAll: () => Promise<void>;
  analyzeRecentFiles: () => Promise<void>; // old method for backward compatibility
  analyzeHotspots: () => Promise<void>; // old method for backward compatibility
  clearAnalysis: () => void;
}

const IGNORED_FILES = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '.DS_Store',
  'thumbs.db',
];

const shouldAnalyzeFile = (filepath: string): boolean => {
  if (IGNORED_FILES.some((ignored) => filepath.endsWith(ignored))) return false;
  const ext = filepath.substring(filepath.lastIndexOf('.')) || '';
  if (BINARY_FILE_EXTENSIONS.includes(ext)) return false;
  return TEXT_FILE_EXTENSIONS.includes(ext);
};

// Logarithmic scaling for changes
const calculateChangeWeight = (differentLines: number): number => {
  const baseWeight = Math.log2(differentLines + 1);
  const maxWeight = 10;
  return Math.min(baseWeight, maxWeight);
};

// New helper to calculate weighted change based on file extension
const calculateWeightedChange = (filepath: string, differentLines: number): number => {
  const baseWeight = calculateChangeWeight(differentLines);
  const ext = filepath.substring(filepath.lastIndexOf('.'));
  if (CODE_FILE_EXTENSIONS.includes(ext)) {
    return baseWeight * CODE_MULTIPLIER;
  }
  return baseWeight;
};

export const useGitAnalysisStore = create<GitAnalysisState>((set, get) => ({
  recentlyTouchedFiles: [],
  hotspotData: [],
  commitRangeConfig: {
    depth: DEFAULT_DEPTH,
    usePartial: true,
  },
  isAnalyzing: false,
  error: null,

  setCommitRangeConfig: (config) => {
    set((state) => ({
      commitRangeConfig: { ...state.commitRangeConfig, ...config },
    }));
  },

  /**
   * The main single-pass analysis routine that gathers both "recently touched" and "hotspots".
   */
  analyzeAll: async () => {
    const gitStore = useGitStore.getState();
    const { fs, path } = gitStore;
    console.log('[GitAnalysis] Starting analyzeAll...', {
      fsExists: !!fs,
      path,
    });

    if (!fs || !path) {
      console.error('[GitAnalysis] Error: Git store not initialized.');
      set({ error: 'Git store not initialized', isAnalyzing: false });
      return;
    }

    set({ isAnalyzing: true, error: null });

    try {
      console.log('[GitAnalysis] Fetching commit log...');
      const { depth, startDate, endDate } = get().commitRangeConfig;
      // If date range is provided, override depth with a higher number to cover a broad time span
      const effectiveDepth = startDate || endDate ? 5000 : depth;
      const commits = await git.log({ fs, dir: path, depth: effectiveDepth });
      console.log(`[GitAnalysis] Fetched ${commits.length} commits.`);

      // Filter out merge commits
      let nonMergeCommits = commits.filter(
        (commit) => !commit.commit.parent || commit.commit.parent.length <= 1
      );

      // If a date range is specified, filter commits based on commit timestamp
      if (startDate || endDate) {
        nonMergeCommits = nonMergeCommits.filter((commit) => {
          const ts = commit.commit.author.timestamp;
          if (startDate && ts < Math.floor(startDate.getTime() / 1000)) return false;
          if (endDate && ts > Math.floor(endDate.getTime() / 1000)) return false;
          return true;
        });
      }

      console.log(`[GitAnalysis] Processing ${nonMergeCommits.length} non-merge commits.`);

      // We'll gather data for "recently touched" + "hotspots" in a single pass.
      const now = Math.floor(Date.now() / 1000);
      const days30 = 30 * 24 * 60 * 60;

      // For recently touched:
      const touchedFiles = new Map<string, { lastCommitTimestamp: number; changes: number }>();

      // For hotspots:
      const hotspots = new Map<
        string,
        {
          path: string;
          score: number;
          changes: number;
          lastModified: number;
          totalLinesChanged: number;
        }
      >();

      // Walk commits
      for (const commit of nonMergeCommits) {
        const parentCommit = commit.commit.parent?.[0];
        if (!parentCommit) continue;

        let currentCommit: { commit: { tree: string } };
        let parentCommitObj: { commit: { tree: string } };
        try {
          currentCommit = await git.readCommit({
            fs,
            dir: path,
            oid: commit.oid,
          });
          parentCommitObj = await git.readCommit({
            fs,
            dir: path,
            oid: parentCommit,
          });
        } catch (err) {
          // If we fail reading a commit, log it and skip
          console.error(
            `[GitAnalysis] Failed to read commit or parent commit.
Commit OID: ${commit.oid}
Parent OID: ${parentCommit}
Error:`,
            err
          );
          continue;
        }

        await git.walk({
          fs,
          dir: path,
          trees: [
            git.TREE({ ref: currentCommit.commit.tree }),
            git.TREE({ ref: parentCommitObj.commit.tree }),
          ],
          map: async (filepath, [A, B]) => {
            if (!A || !B) return;

            const [typeA, typeB] = await Promise.all([A.type(), B.type()]);
            if (typeA === 'tree' && typeB === 'tree') return;

            const oidA = await A.oid();
            const oidB = await B.oid();
            if (oidA === oidB) return; // no change

            if (shouldAnalyzeFile(filepath)) {
              try {
                const [blobA, blobB] = await Promise.all([
                  git.readBlob({ fs, dir: path, oid: oidA }),
                  git.readBlob({ fs, dir: path, oid: oidB }),
                ]);
                const contentAStr = new TextDecoder().decode(blobA.blob);
                const contentBStr = new TextDecoder().decode(blobB.blob);

                if (contentAStr !== contentBStr) {
                  // Update "recent files" data
                  const recInfo = touchedFiles.get(filepath) || {
                    lastCommitTimestamp: 0,
                    changes: 0,
                  };
                  touchedFiles.set(filepath, {
                    lastCommitTimestamp: Math.max(
                      recInfo.lastCommitTimestamp,
                      commit.commit.author.timestamp
                    ),
                    changes: recInfo.changes + 1,
                  });

                  // Update "hotspots" data
                  const linesA = contentAStr.split('\n');
                  const linesB = contentBStr.split('\n');
                  let differentLines = 0;
                  const maxLines = Math.max(linesA.length, linesB.length);
                  for (let i = 0; i < maxLines; i++) {
                    if (linesA[i] !== linesB[i]) {
                      differentLines++;
                    }
                  }

                  const timeDiff = now - commit.commit.author.timestamp;
                  const timeWeight = Math.max(0.1, 1 - timeDiff / days30);
                  const changeWeight = calculateWeightedChange(filepath, differentLines);
                  const weight = timeWeight * changeWeight;

                  const existingData = hotspots.get(filepath) || {
                    path: filepath,
                    score: 0,
                    changes: 0,
                    lastModified: 0,
                    totalLinesChanged: 0,
                  };

                  hotspots.set(filepath, {
                    ...existingData,
                    score: existingData.score + weight,
                    changes: existingData.changes + 1,
                    lastModified: Math.max(
                      existingData.lastModified,
                      commit.commit.author.timestamp
                    ),
                    totalLinesChanged: existingData.totalLinesChanged + differentLines,
                  });
                }
              } catch (blobErr) {
                console.error(
                  `[GitAnalysis] Failed to read blob for file "${filepath}".\nBlob A OID: ${oidA}\nBlob B OID: ${oidB}\nError:`,
                  blobErr
                );
                // continue
              }
            }
          },
        });
      }

      // Convert results to sorted arrays
      const recentArray = Array.from(touchedFiles.entries())
        .map(([path, info]) => ({
          path,
          lastCommitTimestamp: info.lastCommitTimestamp,
          changes: info.changes,
        }))
        .sort((a, b) => b.lastCommitTimestamp - a.lastCommitTimestamp);

      const hotspotArray = Array.from(hotspots.values()).sort((a, b) => b.score - a.score);

      set({
        recentlyTouchedFiles: recentArray,
        hotspotData: hotspotArray.map((h) => ({
          ...h,
          score: Number(h.score.toFixed(2)), // round to 2 decimals
        })),
        isAnalyzing: false,
      });
    } catch (error: unknown) {
      set({
        error: `Unified analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        isAnalyzing: false,
      });
    }
  },

  /**
   * Legacy function for "recent files" - calls the new analyzeAll.
   */
  analyzeRecentFiles: async () => {
    // Call the unified analysis. Then the UI can read recentlyTouchedFiles from the store.
    await get().analyzeAll();
  },

  /**
   * Legacy function for "hotspots" - calls the new analyzeAll.
   */
  analyzeHotspots: async () => {
    // Same approach
    await get().analyzeAll();
  },

  clearAnalysis: () => {
    set({
      recentlyTouchedFiles: [],
      hotspotData: [],
      error: null,
    });
  },
}));
