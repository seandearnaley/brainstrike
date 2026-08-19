import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { CredentialRow } from '../credential-inventory/credential-row';
import type { CredentialSlot } from '../credential-inventory/credential-slots';

vi.mock('@brainstrike/ui', () => ({
  Badge: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => <span data-testid={testId}>{children}</span>,
  Button: ({
    children,
    'data-testid': testId,
  }: {
    children: React.ReactNode;
    'data-testid'?: string;
  }) => (
    <button data-testid={testId} type="button">
      {children}
    </button>
  ),
  getProviderColor: () => 'hsl(0, 0%, 50%)',
  ProviderIcon: () => <span />,
  TableCell: ({ children }: { children?: React.ReactNode }) => <td>{children}</td>,
  TableRow: ({
    children,
    className,
    'data-highlighted': highlighted,
    'data-testid': testId,
    ref,
  }: {
    children: React.ReactNode;
    className?: string;
    'data-highlighted'?: string;
    'data-testid'?: string;
    ref?: React.Ref<HTMLTableRowElement>;
  }) => (
    <tr className={className} data-highlighted={highlighted} data-testid={testId} ref={ref}>
      {children}
    </tr>
  ),
  TooltipIconButton: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

const SLOT: CredentialSlot = {
  authType: 'api_key',
  displayName: 'OpenAI',
  docsUrl: null,
  envVar: 'OPENAI_API_KEY',
  id: 'openai',
  keyFormatHint: null,
  keyNotes: null,
};

function renderRow(overrides: { highlightNonce?: number; highlighted?: boolean } = {}) {
  const props = {
    busy: false,
    deprecatedReports: [],
    draftKey: '',
    // BST-1353: the aws editor's mode switch. This slot is api_key, so the
    // mode is inert here — but the props are required, and bearer is the
    // reducer's default.
    draftMode: 'bearer' as const,
    draftProfile: '',
    draftRegion: '',
    editing: false,
    highlighted: overrides.highlighted ?? false,
    highlightNonce: overrides.highlightNonce ?? 0,
    onCancelEdit: () => undefined,
    onDraftKeyChange: () => undefined,
    onDraftModeChange: () => undefined,
    onDraftProfileChange: () => undefined,
    onDraftRegionChange: () => undefined,
    onOpenEditor: () => undefined,
    onRemove: () => undefined,
    onSave: () => undefined,
    slot: SLOT,
    source: undefined,
    sourceState: 'ready' as const,
  };
  const view = render(
    <table>
      <tbody>
        <CredentialRow {...props} />
      </tbody>
    </table>
  );
  const rerenderRow = (next: { highlightNonce: number; highlighted: boolean }) =>
    view.rerender(
      <table>
        <tbody>
          <CredentialRow {...props} {...next} />
        </tbody>
      </table>
    );
  return { rerenderRow };
}

describe('CredentialRow cross-link highlight (BST-1363)', () => {
  // jsdom does not implement scrollIntoView. Save and restore the original so
  // the stub cannot leak into any other suite.
  const originalScrollIntoView = Element.prototype.scrollIntoView;
  let scrollIntoView: Mock<(options?: boolean | ScrollIntoViewOptions) => void>;

  beforeEach(() => {
    scrollIntoView = vi.fn<(options?: boolean | ScrollIntoViewOptions) => void>();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = originalScrollIntoView;
  });

  it('does not ring or scroll an untargeted row', () => {
    renderRow();

    expect(screen.getByTestId('credential-row-openai').dataset['highlighted']).toBeUndefined();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('rings and scrolls itself into view when targeted', () => {
    const { rerenderRow } = renderRow();

    rerenderRow({ highlighted: true, highlightNonce: 1 });

    expect(screen.getByTestId('credential-row-openai').dataset['highlighted']).toBe('true');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('re-scrolls when the SAME row is targeted again under a new nonce', () => {
    const { rerenderRow } = renderRow({ highlighted: true, highlightNonce: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Without the nonce the props would be identical and a repeat click on
    // the same chip would silently do nothing.
    rerenderRow({ highlighted: true, highlightNonce: 2 });

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('drops the ring when the highlight expires, without scrolling again', () => {
    const { rerenderRow } = renderRow({ highlighted: true, highlightNonce: 1 });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerenderRow({ highlighted: false, highlightNonce: 1 });

    expect(screen.getByTestId('credential-row-openai').dataset['highlighted']).toBeUndefined();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
