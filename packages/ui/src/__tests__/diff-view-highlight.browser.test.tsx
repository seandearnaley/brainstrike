/**
 * Changed words read as a fill of the line's own hue, never as the coloured
 * 2px underline `@codemirror/merge`'s base theme draws under them.
 */
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DiffView } from '../diff-view';
import './diff-view-line-comments.browser.css';

const ORIGINAL = 'const host = "localhost";\nconst port = 3000;\n';
const MODIFIED = 'const host = "127.0.0.1";\nconst port = 8080;\n';

test.each(['split', 'unified'] as const)(
  '%s diff marks changed words without an underline',
  async (mode) => {
    render(
      <div style={{ height: 300 }}>
        <DiffView defaultMode={mode} modified={MODIFIED} original={ORIGINAL} testId="diff" />
      </div>
    );
    await expect
      .poll(() => document.querySelectorAll('[data-testid="diff"] .cm-changedText').length)
      .toBeGreaterThan(0);
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-testid="diff"] .cm-changedText, [data-testid="diff"] .cm-deletedText'
    )) {
      const style = getComputedStyle(element);
      expect(style.backgroundImage).toBe('none');
      expect(style.textDecorationLine).toBe('none');
    }
  }
);
