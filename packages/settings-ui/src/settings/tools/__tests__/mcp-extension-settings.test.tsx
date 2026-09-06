/**
 * Global registered-extension off switch (BST-1604).
 */

import '@testing-library/jest-dom/vitest';
import type { McpExtensionEnablement } from '@brainstrike/assistant-contract';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpExtensionSettings } from '../mcp-extension-settings';

const BOTH_ON: McpExtensionEnablement = { apps: true, tasks: true };

describe('McpExtensionSettings', () => {
  it('renders one switch per registered extension, both on by default', async () => {
    render(
      <McpExtensionSettings
        getPreferences={vi.fn(async () => BOTH_ON)}
        setPreferences={vi.fn(async (preferences: McpExtensionEnablement) => preferences)}
      />
    );

    expect(screen.getByTestId('mcp-extension-settings')).toBeInTheDocument();
    const apps = await screen.findByTestId('mcp-extension-toggle-apps');
    const tasks = screen.getByTestId('mcp-extension-toggle-tasks');
    await waitFor(() => expect(apps).toBeEnabled());
    expect(apps).toHaveAttribute('data-state', 'checked');
    expect(tasks).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText('io.modelcontextprotocol/ui')).toBeInTheDocument();
    expect(screen.getByText('io.modelcontextprotocol/tasks')).toBeInTheDocument();
  });

  it('writes the full enablement through setPreferences when a switch flips off', async () => {
    const setPreferences = vi.fn(async (preferences: McpExtensionEnablement) => preferences);
    render(
      <McpExtensionSettings
        getPreferences={vi.fn(async () => BOTH_ON)}
        setPreferences={setPreferences}
      />
    );

    const tasks = await screen.findByTestId('mcp-extension-toggle-tasks');
    await waitFor(() => expect(tasks).toBeEnabled());
    fireEvent.click(tasks);

    await waitFor(() => expect(setPreferences).toHaveBeenCalledWith({ apps: true, tasks: false }));
    await waitFor(() => expect(tasks).toHaveAttribute('data-state', 'unchecked'));
    expect(screen.getByTestId('mcp-extension-toggle-apps')).toHaveAttribute(
      'data-state',
      'checked'
    );
  });

  it('disables the switches while a write is in flight', async () => {
    let settle: ((preferences: McpExtensionEnablement) => void) | null = null;
    const setPreferences = vi.fn(
      () =>
        new Promise<McpExtensionEnablement>((resolve) => {
          settle = resolve;
        })
    );
    render(
      <McpExtensionSettings
        getPreferences={vi.fn(async () => BOTH_ON)}
        setPreferences={setPreferences}
      />
    );

    const apps = await screen.findByTestId('mcp-extension-toggle-apps');
    await waitFor(() => expect(apps).toBeEnabled());
    fireEvent.click(apps);

    await waitFor(() => expect(apps).toBeDisabled());
    expect(screen.getByTestId('mcp-extension-toggle-tasks')).toBeDisabled();
    act(() => settle?.({ apps: false, tasks: true }));
    await waitFor(() => expect(apps).toBeEnabled());
  });

  it('surfaces a rejected write instead of silently reverting', async () => {
    render(
      <McpExtensionSettings
        getPreferences={vi.fn(async () => BOTH_ON)}
        setPreferences={vi.fn(() => Promise.reject(new Error('store is read-only')))}
      />
    );

    const apps = await screen.findByTestId('mcp-extension-toggle-apps');
    await waitFor(() => expect(apps).toBeEnabled());
    fireEvent.click(apps);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('store is read-only');
    // The persisted state never changed, so the switch never moved.
    expect(apps).toHaveAttribute('data-state', 'checked');
  });

  it('surfaces a rejected read', async () => {
    render(
      <McpExtensionSettings
        getPreferences={vi.fn(() => Promise.reject(new Error('preferences unreadable')))}
        setPreferences={vi.fn(async (preferences: McpExtensionEnablement) => preferences)}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('preferences unreadable');
    expect(screen.getByTestId('mcp-extension-toggle-apps')).toBeDisabled();
  });

  it('re-renders on a subscription push', async () => {
    let push: ((preferences: McpExtensionEnablement) => void) | null = null;
    const unsubscribe = vi.fn();
    render(
      <McpExtensionSettings
        getPreferences={vi.fn(async () => BOTH_ON)}
        setPreferences={vi.fn(async (preferences: McpExtensionEnablement) => preferences)}
        subscribe={(listener) => {
          push = listener;
          return unsubscribe;
        }}
      />
    );

    const apps = await screen.findByTestId('mcp-extension-toggle-apps');
    await waitFor(() => expect(apps).toHaveAttribute('data-state', 'checked'));
    act(() => push?.({ apps: false, tasks: true }));
    await waitFor(() => expect(apps).toHaveAttribute('data-state', 'unchecked'));
  });

  it('mirrors the loaded state to the parent for the support matrix', async () => {
    const onPreferencesChange = vi.fn();
    render(
      <McpExtensionSettings
        getPreferences={vi.fn(async () => ({ apps: false, tasks: true }))}
        onPreferencesChange={onPreferencesChange}
        setPreferences={vi.fn(async (preferences: McpExtensionEnablement) => preferences)}
      />
    );

    await waitFor(() =>
      expect(onPreferencesChange).toHaveBeenCalledWith({ apps: false, tasks: true })
    );
  });
});
