import { parseSync } from 'oxc-parser';
import type { AstNode, ParseOptions, ParserAdapter } from './types';

/** Same vendor dialect and recovery policy as the desktop parser-host entry. */
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
