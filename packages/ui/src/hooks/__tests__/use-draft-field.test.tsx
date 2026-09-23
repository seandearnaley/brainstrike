import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDraftFieldScope, DraftFieldScopeContext, useDraftField } from '../use-draft-field';

afterEach(() => {
  cleanup();
});

/** A stored integer edited through the hook; `commit` refuses anything above `max`. */
function Harness({
  max = 1000,
  onRevert,
  onStore,
}: {
  readonly max?: number;
  readonly onRevert?: () => void;
  readonly onStore: (value: number) => void;
}) {
  const [stored, setStored] = useState(100);
  const field = useDraftField({
    commit: (draft) => {
      if (draft.badInput) {
        return 'That is not a number.';
      }
      const value = Number(draft.text);
      if (!Number.isInteger(value) || value > max) {
        return `Enter a whole number up to ${max}.`;
      }
      onStore(value);
      setStored(value);
      return;
    },
    ...(onRevert ? { onRevert } : {}),
    value: String(stored),
  });
  return (
    <>
      <input aria-label="Steps" type="number" {...field.inputProps} />
      {field.error ? <p role="alert">{field.error}</p> : null}
      <p data-testid="stored">{stored}</p>
    </>
  );
}

describe('useDraftField', () => {
  it('stores nothing while typing and commits the whole draft on blur', async () => {
    const user = userEvent.setup();
    const onStore = vi.fn();
    render(<Harness onStore={onStore} />);
    const input = screen.getByLabelText('Steps');
    await user.clear(input);
    await user.type(input, '128');
    expect(onStore).not.toHaveBeenCalled();
    expect(input).toHaveValue(128);
    await user.tab();
    expect(onStore.mock.calls).toEqual([[128]]);
    expect(screen.getByTestId('stored')).toHaveTextContent('128');
  });

  it('commits on Enter', async () => {
    const user = userEvent.setup();
    const onStore = vi.fn();
    render(<Harness onStore={onStore} />);
    const input = screen.getByLabelText('Steps');
    await user.clear(input);
    await user.type(input, '48{Enter}');
    expect(onStore.mock.calls).toEqual([[48]]);
    expect(input).toHaveFocus();
  });

  it('keeps a refused draft on screen with its message and stores nothing', async () => {
    const user = userEvent.setup();
    const onStore = vi.fn();
    render(<Harness max={64} onStore={onStore} />);
    const input = screen.getByLabelText('Steps');
    await user.clear(input);
    await user.type(input, '128');
    await user.tab();
    expect(onStore).not.toHaveBeenCalled();
    expect(input).toHaveValue(128);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number up to 64.');
    await user.clear(input);
    await user.type(input, '32');
    // The message describes the last COMMIT, not the draft being typed.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.tab();
    expect(onStore.mock.calls).toEqual([[32]]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('Escape discards the draft and its message, and the following blur stores nothing', async () => {
    const user = userEvent.setup();
    const onStore = vi.fn();
    const onRevert = vi.fn();
    render(<Harness max={64} onRevert={onRevert} onStore={onStore} />);
    const input = screen.getByLabelText('Steps');
    await user.clear(input);
    await user.type(input, '128{Enter}');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.type(input, '{Escape}');
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue(100);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.tab();
    expect(onStore).not.toHaveBeenCalled();
  });

  it('a blur without an edit commits nothing', async () => {
    const user = userEvent.setup();
    const onStore = vi.fn();
    render(<Harness onStore={onStore} />);
    await user.click(screen.getByLabelText('Steps'));
    await user.tab();
    expect(onStore).not.toHaveBeenCalled();
  });

  it('shows the stored value again once a commit lands', async () => {
    const user = userEvent.setup();
    const onStore = vi.fn();
    render(<Harness onStore={onStore} />);
    const input = screen.getByLabelText('Steps');
    await user.clear(input);
    await user.type(input, '007');
    await user.tab();
    expect(onStore.mock.calls).toEqual([[7]]);
    // The draft text "007" is gone; the field renders the stored value.
    expect((input as HTMLInputElement).value).toBe('7');
  });

  it("hands commit the browser's bad-input report, so unparseable text is never read as empty", () => {
    const onStore = vi.fn();
    render(<Harness onStore={onStore} />);
    const input = screen.getByLabelText('Steps');
    // A browser reports value '' with validity.badInput for "1.", "-" or "1e";
    // jsdom never sets badInput, so model the browser's report directly.
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent('That is not a number.');
    expect(onStore).not.toHaveBeenCalled();
  });

  it('lets an enclosing scope commit every pending draft, keeping each refusal visible', () => {
    const scope = createDraftFieldScope();
    const onStore = vi.fn();
    const { unmount } = render(
      <DraftFieldScopeContext value={scope}>
        <Harness max={64} onStore={onStore} />
      </DraftFieldScopeContext>
    );
    const input = screen.getByLabelText('Steps');
    // Nothing pending: the scope has nothing to refuse.
    expect(scope.commitAll()).toBe(true);
    fireEvent.change(input, { target: { value: '128' } });
    let landed = true;
    act(() => {
      landed = scope.commitAll();
    });
    expect(landed).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number up to 64.');
    expect(input).toHaveValue(128);
    fireEvent.change(input, { target: { value: '32' } });
    act(() => {
      landed = scope.commitAll();
    });
    expect(landed).toBe(true);
    expect(onStore.mock.calls).toEqual([[32]]);
    // A second commit of the same interaction stores nothing more.
    act(() => {
      landed = scope.commitAll();
    });
    expect(onStore).toHaveBeenCalledTimes(1);
    // An unmounted field leaves the scope, refused draft and all.
    fireEvent.change(input, { target: { value: '999' } });
    unmount();
    expect(scope.commitAll()).toBe(true);
  });

  it("commits through the LATEST render's rules when the scope calls in", () => {
    const scope = createDraftFieldScope();
    const onStore = vi.fn();
    const { rerender } = render(
      <DraftFieldScopeContext value={scope}>
        <Harness max={64} onStore={onStore} />
      </DraftFieldScopeContext>
    );
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '120' } });
    // The limit rises after the draft was typed; the scope must not apply the old one.
    rerender(
      <DraftFieldScopeContext value={scope}>
        <Harness max={128} onStore={onStore} />
      </DraftFieldScopeContext>
    );
    let landed = false;
    act(() => {
      landed = scope.commitAll();
    });
    expect(landed).toBe(true);
    expect(onStore.mock.calls).toEqual([[120]]);
  });

  it('revert() reports through onRevert, so no caller can forget to clear a refusal', () => {
    const onRevert = vi.fn();
    let revert: (() => void) | undefined;
    function RevertHarness() {
      const field = useDraftField({ commit: () => 'never valid', onRevert, value: '1' });
      revert = field.revert;
      return <input aria-label="Field" {...field.inputProps} />;
    }
    render(<RevertHarness />);
    fireEvent.change(screen.getByLabelText('Field'), { target: { value: '2' } });
    act(() => {
      revert?.();
    });
    expect(onRevert).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Field')).toHaveValue('1');
  });

  it('does not commit a refused draft again as-is; returning to the field re-validates it', async () => {
    const user = userEvent.setup();
    const commit = vi.fn(() => 'Too large.');
    function CountingHarness() {
      const field = useDraftField({ commit, value: '1' });
      return (
        <>
          <input aria-label="Field" {...field.inputProps} />
          {field.error ? <p role="alert">{field.error}</p> : null}
        </>
      );
    }
    render(<CountingHarness />);
    const input = screen.getByLabelText('Field');
    await user.clear(input);
    await user.type(input, '9{Enter}');
    expect(commit).toHaveBeenCalledTimes(1);
    // The blur after a refused Enter repeats nothing: same draft, same outcome.
    await user.tab();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Too large.');
    // Coming back to the field (its rules may have changed meanwhile) re-checks it.
    await user.click(input);
    await user.tab();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('an unmount with a standing refusal reports the revert; one without reports nothing', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn();
    function RefusingField() {
      const field = useDraftField({ commit: () => 'Too large.', onRevert, value: '1' });
      return <input aria-label="Field" {...field.inputProps} />;
    }
    const clean = render(<RefusingField />);
    clean.unmount();
    expect(onRevert).not.toHaveBeenCalled();

    const refused = render(<RefusingField />);
    const input = screen.getByLabelText('Field');
    await user.clear(input);
    await user.type(input, '9{Enter}');
    refused.unmount();
    expect(onRevert).toHaveBeenCalledTimes(1);
  });
});
