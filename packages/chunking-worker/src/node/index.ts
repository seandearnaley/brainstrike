import { babelAdapter } from '../parsers/babel-adapter';
import { oxcNativeAdapter } from '../parsers/oxc-native-adapter';
import { treeSitterAdapter } from '../parsers/tree-sitter-adapter';
import { chunkContent, type PortableChunkingResult } from '../portable-chunking';
import type { ChunkingRequestOptions } from '../shared';

export type { PortableChunkingResult } from '../portable-chunking';
export type { ChunkingRequestOptions, PortableChunk } from '../shared';

export interface NodeChunkerOptions {
  readonly parser: 'oxc' | 'babel';
  readonly treeSitterLanguages: readonly 'python'[];
}
export type NodeChunker = (
  content: string,
  options: ChunkingRequestOptions & { fileName?: string; filePath?: string }
) => Promise<PortableChunkingResult>;

/** Execute the production algorithm in its utility/CLI owner, with explicit parser capabilities. */
export function createNodeChunker(options: NodeChunkerOptions): NodeChunker {
  if ((process as { type?: string }).type === 'browser') {
    throw new Error('Canonical chunking must run in the utility process, never Electron main.');
  }
  if (
    (options.parser !== 'oxc' && options.parser !== 'babel') ||
    !Array.isArray(options.treeSitterLanguages) ||
    options.treeSitterLanguages.some((language) => language !== 'python')
  ) {
    throw new Error('Canonical Node parser configuration is invalid.');
  }
  const enabledTreeSitterLanguages = [...options.treeSitterLanguages];
  const codeAdapter = options.parser === 'oxc' ? oxcNativeAdapter : babelAdapter;
  return (content, chunkOptions) =>
    chunkContent(content, chunkOptions, {
      enabledTreeSitterLanguages,
      selectAdapter: (fileName) => {
        if (/\.pyi?$/i.test(fileName ?? '')) {
          return enabledTreeSitterLanguages.includes('python') ? treeSitterAdapter('python') : null;
        }
        return codeAdapter;
      },
      strict: true,
    });
}
