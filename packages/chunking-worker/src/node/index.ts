import { babelAdapter } from '../parsers/babel-adapter';
import { oxcNativeAdapter } from '../parsers/oxc-native-adapter';
import { treeSitterAdapter } from '../parsers/tree-sitter-adapter';
import { chunkContent, type PortableChunkingResult } from '../portable-chunking';
import type { ChunkingRequestOptions } from '../shared';

export type { ChunkSkipCode, PortableChunkingResult } from '../portable-chunking';
export type { ChunkingRequestOptions, PortableChunk } from '../shared';

/**
 * The code parser is the only choice. Python always parses with the vendored
 * tree-sitter grammar: canonical chunking has no configuration in which it
 * claims Python but has no parser for it (BST-1983).
 */
export interface NodeChunkerOptions {
  readonly parser: 'oxc' | 'babel';
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
  if (options.parser !== 'oxc' && options.parser !== 'babel') {
    throw new Error('Canonical Node parser configuration is invalid.');
  }
  const codeAdapter = options.parser === 'oxc' ? oxcNativeAdapter : babelAdapter;
  const pythonAdapter = treeSitterAdapter('python');
  return (content, chunkOptions) =>
    chunkContent(content, chunkOptions, {
      selectAdapter: (fileName) => (/\.pyi?$/i.test(fileName ?? '') ? pythonAdapter : codeAdapter),
      strict: true,
    });
}
