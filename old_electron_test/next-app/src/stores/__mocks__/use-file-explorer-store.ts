import type { IFileNode } from '@/lib/file/types';
import { create } from 'zustand';

interface FileExplorerState {
  selectedFilePaths: Set<string>;
  expandedDirectoryPaths: Set<string>;
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  includeProjectTree: boolean;
  folderSummaryThreshold: number;

  setSelectedFiles: jest.Mock<void, [ReadonlySet<string>]>;
  addSelectedFile: jest.Mock<void, [string]>;
  removeSelectedFile: jest.Mock<void, [string]>;
  clearSelectedFiles: jest.Mock<void, []>;

  setExpandedPaths: jest.Mock<void, [ReadonlySet<string>]>;
  toggleDirectoryExpansion: jest.Mock<void, [string]>;

  setFilters: jest.Mock<void, [readonly string[], readonly string[]]>;
  setUseRegex: jest.Mock<void, [boolean]>;
  setIncludeProjectTree: jest.Mock<void, [boolean]>;
  setFolderSummaryThreshold: jest.Mock<void, [number]>;

  expandAllDirectories: (fileTree: IFileNode[]) => void;
  collapseAllDirectories: () => void;
}

const mockStore = create<FileExplorerState>((set, get) => ({
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 100,

  setSelectedFiles: jest.fn((files: ReadonlySet<string>) => {
    set({ selectedFilePaths: new Set(files) });
  }),

  addSelectedFile: jest.fn((filePath: string) => {
    set((state) => {
      const newSet = new Set(state.selectedFilePaths);
      newSet.add(filePath);
      return { selectedFilePaths: newSet };
    });
  }),

  removeSelectedFile: jest.fn((filePath: string) => {
    set((state) => {
      const newSet = new Set(state.selectedFilePaths);
      newSet.delete(filePath);
      return { selectedFilePaths: newSet };
    });
  }),

  clearSelectedFiles: jest.fn(() => {
    set({ selectedFilePaths: new Set() });
  }),

  setExpandedPaths: jest.fn((paths: ReadonlySet<string>) => {
    set({ expandedDirectoryPaths: new Set(paths) });
  }),

  toggleDirectoryExpansion: jest.fn((path: string) => {
    set((state) => {
      const expanded = new Set(state.expandedDirectoryPaths);
      if (expanded.has(path)) {
        const pathWithSlash = `${path}/`;
        for (const p of [...expanded]) {
          if (p === path || p.startsWith(pathWithSlash)) {
            expanded.delete(p);
          }
        }
      } else {
        expanded.add(path);
      }
      return { expandedDirectoryPaths: expanded };
    });
  }),

  setFilters: jest.fn((include: readonly string[], exclude: readonly string[]) => {
    set({ includeFilters: [...include], excludeFilters: [...exclude] });
  }),

  setUseRegex: jest.fn((useRegex: boolean) => {
    set({ useRegex });
  }),

  setIncludeProjectTree: jest.fn((value: boolean) => {
    set({ includeProjectTree: value });
  }),

  setFolderSummaryThreshold: jest.fn((value: number) => {
    set({ folderSummaryThreshold: value });
  }),

  expandAllDirectories: (fileTree: IFileNode[]) => {
    const state = get();
    const newExpandedPaths = new Set(state.expandedDirectoryPaths);
    const traverse = (nodes: IFileNode[]) => {
      for (const node of nodes) {
        if (node.type === 'directory') {
          newExpandedPaths.add(node.path);
          if (node.children && node.children.length > 0) {
            traverse(node.children);
          }
        }
      }
    };
    traverse(fileTree);
    set({ expandedDirectoryPaths: newExpandedPaths });
  },

  collapseAllDirectories: () => {
    set({ expandedDirectoryPaths: new Set() });
  },
}));

export const useFileExplorerStore = mockStore;
