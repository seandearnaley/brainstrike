import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpConfigPanel } from '../mcp-config-panel';
import type { McpConfigTextDocument, ToolsSettingsOperations } from '../types';

const invalidContent = `{
  // Preserve this comment for the user's repair.
  "servers": [{ "name": "legacy", "transport": "sse", "url": "https://example.test/sse", "auth": { "type": "oauth-user" } }]
}`;
const validationError =
  'invalid_mcp_config: servers.0.auth: auth "oauth-user" is not supported with transport "sse"; use "streamable-http"';
const validContent = invalidContent.replace('"transport": "sse"', '"transport": "streamable-http"');
const path = '/tmp/mcp.config.jsonc';

function document(content: string, error?: string): McpConfigTextDocument {
  return { content, created: false, ...(error === undefined ? {} : { error }), exists: true, path };
}

function operations(editorAvailable = true): ToolsSettingsOperations {
  return {
    disableTools: vi.fn(),
    enableTools: vi.fn(),
    getStats: vi.fn(),
    getTools: vi.fn(),
    readMcpConfigText: vi.fn().mockResolvedValue(document(validContent)),
    resetTools: vi.fn(),
    ...(editorAvailable
      ? { writeMcpConfigText: vi.fn().mockResolvedValue({ path, success: true }) }
      : {}),
  };
}

afterEach(cleanup);

describe('MCP config document validation', () => {
  it('shows a saved config error beside unchanged editable JSONC and clears it after repair', async () => {
    const ops = operations();
    ops.readMcpConfigText = vi.fn().mockResolvedValue(document(invalidContent, validationError));
    const onConfigChanged = vi.fn();
    render(<McpConfigPanel onConfigChanged={onConfigChanged} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    expect(editor).toHaveValue(invalidContent);
    expect(screen.getByTestId('mcp-config-error')).toHaveTextContent(validationError);
    expect(editor).toHaveAttribute('aria-invalid', 'true');
    expect(editor).toHaveAttribute('aria-describedby', 'mcp-config-error-message');
    expect(ops.writeMcpConfigText).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: validContent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('mcp-config-status')).toHaveTextContent('MCP config saved.');
    expect(ops.writeMcpConfigText).toHaveBeenCalledWith(validContent);
    expect(editor).toHaveValue(validContent);
    expect(editor).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
    expect(onConfigChanged).toHaveBeenCalledOnce();
  });

  it('keeps rejected draft content editable without reporting a successful save', async () => {
    const ops = operations();
    ops.writeMcpConfigText = vi
      .fn()
      .mockResolvedValue({ error: validationError, path, success: false });
    const onConfigChanged = vi.fn();
    render(<McpConfigPanel onConfigChanged={onConfigChanged} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.change(editor, { target: { value: invalidContent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('mcp-config-error')).toHaveTextContent(validationError);
    expect(editor).toHaveValue(invalidContent);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.queryByTestId('mcp-config-status')).not.toBeInTheDocument();
    expect(onConfigChanged).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'rejected'] as const)(
    'ignores an older %s reload after a newer valid document has loaded',
    async (outcome) => {
      const older = Promise.withResolvers<McpConfigTextDocument>();
      const ops = operations();
      ops.readMcpConfigText = vi
        .fn()
        .mockResolvedValueOnce(document(validContent))
        .mockReturnValueOnce(older.promise)
        .mockResolvedValueOnce(document('{ "servers": [] }'));
      render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
      const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(editor).toHaveValue('{ "servers": [] }');
      await act(async () => {
        if (outcome === 'invalid') {
          older.resolve(document(invalidContent, validationError));
        } else {
          older.reject(new Error('Older read failed'));
        }
      });
      expect(editor).toHaveValue('{ "servers": [] }');
      expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
    }
  );

  it('preserves edits made while a reload is pending', async () => {
    const reload = Promise.withResolvers<McpConfigTextDocument>();
    const ops = operations();
    ops.readMcpConfigText = vi
      .fn()
      .mockResolvedValueOnce(document(validContent))
      .mockReturnValueOnce(reload.promise);
    render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
    await act(async () => {
      reload.resolve(document(invalidContent, validationError));
    });
    expect(editor).toHaveValue('{ "servers": [] }');
    expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('marks only the submitted text saved when the user edits during a save', async () => {
    const save = Promise.withResolvers<{ path: string; success: true }>();
    const ops = operations();
    ops.readMcpConfigText = vi.fn().mockResolvedValue(document(invalidContent, validationError));
    ops.writeMcpConfigText = vi.fn().mockReturnValue(save.promise);
    render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.change(editor, { target: { value: validContent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
    await act(async () => {
      save.resolve({ path, success: true });
    });
    expect(editor).toHaveValue('{ "servers": [] }');
    expect(ops.writeMcpConfigText).toHaveBeenCalledWith(validContent);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.getByTestId('mcp-config-status')).toHaveTextContent('Newer edits are unsaved.');
  });

  it.each(['invalid', 'io-failure', 'rejected'] as const)(
    'does not attach an old %s save failure to edits made during the request',
    async (outcome) => {
      const save = Promise.withResolvers<{ error: string; path: string; success: false }>();
      const ops = operations();
      ops.writeMcpConfigText = vi
        .fn()
        .mockReturnValueOnce(save.promise)
        .mockResolvedValue({ path, success: true });
      render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
      const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
      fireEvent.change(editor, { target: { value: invalidContent } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
      await act(async () => {
        if (outcome === 'invalid') {
          save.resolve({ error: validationError, path, success: false });
        } else if (outcome === 'io-failure') {
          save.resolve({ error: 'ENOTDIR: not a directory', path, success: false });
        } else {
          save.reject(new Error('Permission denied'));
        }
      });
      expect(editor).toHaveValue('{ "servers": [] }');
      expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(screen.getByTestId('mcp-config-status')).toHaveTextContent(
        'Previous save failed. Review current edits before retrying.'
      );
      expect(screen.getByTestId('mcp-config-status')).toHaveAttribute('data-tone', 'warning');
      expect(screen.getByTestId('mcp-config-status')).toHaveClass('text-warning');
      expect(editor).not.toHaveAttribute('aria-invalid');
      expect(editor).toHaveAttribute('aria-describedby', 'mcp-config-status-message');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('mcp-config-status')).toHaveTextContent('MCP config saved.');
      expect(screen.getByTestId('mcp-config-status')).toHaveAttribute('data-tone', 'success');
      expect(screen.getByTestId('mcp-config-status')).not.toHaveClass('text-warning');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    }
  );

  it('does not attach a stale failed save to a newer document', async () => {
    const save = Promise.withResolvers<{ error: string; path: string; success: false }>();
    const ops = operations();
    ops.writeMcpConfigText = vi.fn().mockReturnValue(save.promise);
    render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.change(editor, { target: { value: invalidContent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and Reload' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor).toHaveValue(validContent);
    await act(async () => {
      save.resolve({ error: validationError, path, success: false });
    });
    expect(editor).toHaveValue(validContent);
    expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-config-status')).not.toBeInTheDocument();
  });

  it('keeps Save and both keyboard shortcuts disabled until the pending reload settles', async () => {
    const reload = Promise.withResolvers<McpConfigTextDocument>();
    const ops = operations();
    ops.readMcpConfigText = vi
      .fn()
      .mockResolvedValueOnce(document(validContent))
      .mockReturnValueOnce(reload.promise);
    render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
    const saveButton = screen.getByRole('button', { name: 'Save' });
    expect(saveButton).toBeDisabled();
    fireEvent.click(saveButton);
    fireEvent.keyDown(editor, { ctrlKey: true, key: 's' });
    fireEvent.keyDown(editor, { key: 's', metaKey: true });
    expect(ops.writeMcpConfigText).not.toHaveBeenCalled();
    await act(async () => {
      reload.resolve(document(validContent));
    });
    expect(editor).toHaveValue('{ "servers": [] }');
    expect(saveButton).toBeEnabled();
  });

  it.each(['valid', 'rejected'] as const)(
    'settles loading after editor capability is restored and its new read is %s',
    async (outcome) => {
      const older = Promise.withResolvers<McpConfigTextDocument>();
      const restored = Promise.withResolvers<McpConfigTextDocument>();
      const ops = operations();
      ops.readMcpConfigText = vi
        .fn()
        .mockResolvedValueOnce(document(validContent))
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(restored.promise);
      const onConfigChanged = vi.fn();
      const { rerender } = render(
        <McpConfigPanel onConfigChanged={onConfigChanged} operations={ops} />
      );
      await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      const unavailable = operations(false);
      rerender(<McpConfigPanel onConfigChanged={onConfigChanged} operations={unavailable} />);
      expect(screen.getByText('MCP config editing is unavailable in this runtime.')).toBeVisible();
      expect(
        screen.queryByRole('textbox', { name: 'Config Editor (JSONC)' })
      ).not.toBeInTheDocument();
      await act(async () => {
        older.resolve(document(invalidContent, validationError));
      });
      rerender(<McpConfigPanel onConfigChanged={onConfigChanged} operations={ops} />);
      await act(async () => {
        if (outcome === 'valid') {
          restored.resolve(document(validContent));
        } else {
          restored.reject(new Error('Current read failed'));
        }
      });
      const editor = screen.getByRole('textbox', { name: 'Config Editor (JSONC)' });
      expect(editor).toHaveValue(validContent);
      fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      if (outcome === 'rejected') {
        expect(screen.getByTestId('mcp-config-error')).toHaveTextContent('Current read failed');
      } else {
        expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
      }
    }
  );

  it('refreshes tools after an obsolete successful save without replacing a newer loaded document', async () => {
    const save = Promise.withResolvers<{ path: string; success: true }>();
    const ops = operations();
    ops.readMcpConfigText = vi
      .fn()
      .mockResolvedValueOnce(document(invalidContent, validationError))
      .mockResolvedValueOnce(document('{ "servers": [] }'));
    ops.writeMcpConfigText = vi.fn().mockReturnValue(save.promise);
    const onConfigChanged = vi.fn();
    render(<McpConfigPanel onConfigChanged={onConfigChanged} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.change(editor, { target: { value: validContent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard and Reload' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor).toHaveValue('{ "servers": [] }');
    await act(async () => {
      save.resolve({ path, success: true });
    });
    expect(editor).toHaveValue('{ "servers": [] }');
    expect(screen.queryByTestId('mcp-config-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(onConfigChanged).toHaveBeenCalledOnce();
  });

  it('does not replace a newer successful save status with an older failure notice', async () => {
    const older = Promise.withResolvers<{ error: string; path: string; success: false }>();
    const ops = operations();
    ops.writeMcpConfigText = vi
      .fn()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValueOnce({ path, success: true });
    render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.change(editor, { target: { value: invalidContent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('mcp-config-status')).toHaveTextContent('MCP config saved.');
    await act(async () => {
      older.resolve({ error: 'ENOTDIR: not a directory', path, success: false });
    });
    expect(screen.getByTestId('mcp-config-status')).toHaveTextContent('MCP config saved.');
    expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('does not call a successful write failed when its tools refresh rejects after an edit', async () => {
    const refresh = Promise.withResolvers<void>();
    const ops = operations();
    render(<McpConfigPanel onConfigChanged={() => refresh.promise} operations={ops} />);
    const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
    fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByTestId('mcp-config-status')).toHaveTextContent('MCP config saved.');
    fireEvent.change(editor, { target: { value: validContent } });
    await act(async () => {
      refresh.reject(new Error('Tools refresh failed'));
    });
    expect(editor).toHaveValue(validContent);
    expect(screen.getByTestId('mcp-config-status')).toHaveTextContent('MCP config saved.');
    expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});
