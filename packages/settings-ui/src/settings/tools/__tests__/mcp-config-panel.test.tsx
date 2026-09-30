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

function operations(): ToolsSettingsOperations {
  return {
    disableTools: vi.fn(),
    enableTools: vi.fn(),
    getStats: vi.fn(),
    getTools: vi.fn(),
    readMcpConfigText: vi.fn().mockResolvedValue(document(validContent)),
    resetTools: vi.fn(),
    writeMcpConfigText: vi.fn().mockResolvedValue({ path, success: true }),
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

  it.each(['invalid', 'rejected'] as const)(
    'does not attach an old %s save failure to edits made during the request',
    async (outcome) => {
      const save = Promise.withResolvers<{ error: string; path: string; success: false }>();
      const ops = operations();
      ops.writeMcpConfigText = vi.fn().mockReturnValue(save.promise);
      render(<McpConfigPanel onConfigChanged={vi.fn()} operations={ops} />);
      const editor = await screen.findByRole('textbox', { name: 'Config Editor (JSONC)' });
      fireEvent.change(editor, { target: { value: invalidContent } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      fireEvent.change(editor, { target: { value: '{ "servers": [] }' } });
      await act(async () => {
        if (outcome === 'invalid') {
          save.resolve({ error: validationError, path, success: false });
        } else {
          save.reject(new Error(validationError));
        }
      });
      expect(editor).toHaveValue('{ "servers": [] }');
      expect(screen.queryByTestId('mcp-config-error')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
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
  });
});
