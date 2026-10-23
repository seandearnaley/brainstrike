import { parseSync } from 'oxc-parser';
import type { AstNode, ParseOptions, ParserAdapter } from './types';

/** Parses in-process with native oxc; without `errorRecovery`, oxc's first error is thrown. */
export const oxcNativeAdapter: ParserAdapter = {
  id: 'oxc-native',
  async parse(content: string, options: ParseOptions): Promise<AstNode> {
    const extension = options.language === 'typescript' ? 'ts' : 'js';
    const result = parseSync(`source.${extension}${options.jsx ? 'x' : ''}`, content);
    if (!options.errorRecovery && result.errors.length > 0) {
      throw new Error(result.errors[0]?.message ?? 'Canonical OXC parser reported errors.');
    }
    return result.program as unknown as AstNode;
  },
};
