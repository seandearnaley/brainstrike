import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodeSurface } from '../code-surface';

describe('CodeSurface', () => {
  it('mounts a read-only CodeMirror surface with line numbers and resolved language metadata', async () => {
    render(
      <CodeSurface
        ariaLabel="Source preview"
        path="src/example.ts"
        testId="source-preview"
        value={'export const answer = 42;\nconsole.log(answer);\n'}
      />
    );

    const surface = await screen.findByTestId('source-preview');
    expect(surface).toHaveAttribute('data-language', 'TypeScript');
    expect(surface).toHaveAttribute('data-editable', 'false');
    expect(surface.querySelector('.cm-editor')).toBeInTheDocument();
    expect(surface.querySelector('.cm-lineNumbers')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Source preview' })).toHaveAttribute(
      'contenteditable',
      'false'
    );
    expect(surface).toHaveTextContent('export const answer = 42;');
  });

  it('exposes future editor hooks without making read-only usage editable by default', async () => {
    const onChange = vi.fn();

    render(
      <CodeSurface
        onChange={onChange}
        path="README.md"
        testId="markdown-preview"
        value={'# Brainstrike\n\nLocal-first code context.\n'}
      />
    );

    const surface = await screen.findByTestId('markdown-preview');
    expect(surface).toHaveAttribute('data-language', 'Markdown');
    expect(surface).toHaveAttribute('data-editable', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });
});
