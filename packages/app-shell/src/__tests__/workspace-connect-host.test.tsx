import {
  addLogListener,
  configureLogger,
  LogLevel,
  type LogRecord,
  resetLogger,
} from '@brainstrike/logging';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { connectPathCapabilityRef, connectPathMock, openPickerMock } = vi.hoisted(() => ({
  connectPathCapabilityRef: { current: true },
  connectPathMock: vi.fn(),
  openPickerMock: vi.fn(),
}));

vi.mock('../workspace-connect/use-connect-folder', () => ({
  useConnectFolder: () => ({
    openPicker: openPickerMock,
    ...(connectPathCapabilityRef.current ? { connectPath: connectPathMock } : {}),
  }),
}));

import { WorkspaceConnectHost } from '../workspace-connect/workspace-connect-host';

interface MutableWindow {
  workspace?: unknown;
}

interface TestBridge {
  readonly bridge: {
    readonly getDroppedPath: ReturnType<typeof vi.fn>;
    readonly notifyOpenPathReady: ReturnType<typeof vi.fn>;
    readonly onOpenFolderPicker: ReturnType<typeof vi.fn>;
    readonly onOpenPath: ReturnType<typeof vi.fn>;
  };
  readonly getOpenPathCallback: () => ((request: unknown) => void) | undefined;
  readonly openFolderPickerUnsubscribe: ReturnType<typeof vi.fn>;
  readonly openPathUnsubscribe: ReturnType<typeof vi.fn>;
}

function createTestBridge(): TestBridge {
  let openPathCallback: ((request: unknown) => void) | undefined;
  const openFolderPickerUnsubscribe = vi.fn();
  const openPathUnsubscribe = vi.fn();
  return {
    bridge: {
      getDroppedPath: vi.fn(),
      notifyOpenPathReady: vi.fn(),
      onOpenFolderPicker: vi.fn((_callback: () => void) => openFolderPickerUnsubscribe),
      onOpenPath: vi.fn((callback: (request: unknown) => void) => {
        openPathCallback = callback;
        return openPathUnsubscribe;
      }),
    },
    getOpenPathCallback: () => openPathCallback,
    openFolderPickerUnsubscribe,
    openPathUnsubscribe,
  };
}

describe('WorkspaceConnectHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectPathCapabilityRef.current = true;
    connectPathMock.mockResolvedValue(undefined);
    openPickerMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    (window as MutableWindow).workspace = undefined;
    resetLogger();
  });

  it('subscribes both bridge entry points once and unsubscribes both on unmount', () => {
    const testBridge = createTestBridge();
    (window as MutableWindow).workspace = testBridge.bridge;

    const { unmount } = render(<WorkspaceConnectHost />);

    expect(testBridge.bridge.onOpenFolderPicker).toHaveBeenCalledTimes(1);
    expect(testBridge.bridge.onOpenPath).toHaveBeenCalledTimes(1);

    unmount();

    expect(testBridge.openFolderPickerUnsubscribe).toHaveBeenCalledTimes(1);
    expect(testBridge.openPathUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('pings notifyOpenPathReady exactly once, AFTER subscribing to onOpenPath, in the same effect', () => {
    const testBridge = createTestBridge();
    (window as MutableWindow).workspace = testBridge.bridge;

    render(<WorkspaceConnectHost />);

    expect(testBridge.bridge.notifyOpenPathReady).toHaveBeenCalledTimes(1);
    // Ordering matters: main treats this ping as proof the subscription
    // above already exists, so a ping sent BEFORE `onOpenPath` would be a
    // lie main could act on.
    const subscribeOrder = testBridge.bridge.onOpenPath.mock.invocationCallOrder[0];
    const readyOrder = testBridge.bridge.notifyOpenPathReady.mock.invocationCallOrder[0];
    expect(subscribeOrder).toBeLessThan(readyOrder as number);
  });

  it('subscribes to nothing when the workspace bridge is absent', () => {
    const testBridge = createTestBridge();

    render(<WorkspaceConnectHost />);

    expect(testBridge.bridge.onOpenFolderPicker).not.toHaveBeenCalled();
    expect(testBridge.bridge.onOpenPath).not.toHaveBeenCalled();
    expect(testBridge.bridge.notifyOpenPathReady).not.toHaveBeenCalled();
  });

  it('keeps picker subscription but omits path subscription (and the ready ping) without picker-less capability', () => {
    connectPathCapabilityRef.current = false;
    const testBridge = createTestBridge();
    (window as MutableWindow).workspace = testBridge.bridge;

    render(<WorkspaceConnectHost />);

    expect(testBridge.bridge.onOpenFolderPicker).toHaveBeenCalledTimes(1);
    expect(testBridge.bridge.onOpenPath).not.toHaveBeenCalled();
    expect(testBridge.bridge.notifyOpenPathReady).not.toHaveBeenCalled();
  });

  it('logs and refuses a malformed open-path payload', () => {
    configureLogger({ console: false });
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => {
      records.push(record);
    });
    const testBridge = createTestBridge();
    (window as MutableWindow).workspace = testBridge.bridge;
    render(<WorkspaceConnectHost />);

    try {
      act(() => {
        testBridge.getOpenPathCallback()?.({ origin: 'nope' });
      });
    } finally {
      unsubscribe();
    }

    expect(records).toContainEqual(
      expect.objectContaining({
        level: LogLevel.ERROR,
        message: 'Ignored a malformed workspace open-path request',
        scope: 'WorkspaceConnectHost',
      })
    );
    expect(connectPathMock).not.toHaveBeenCalled();
  });

  it('routes a well-formed open-path payload exactly once through connectPath', () => {
    const testBridge = createTestBridge();
    (window as MutableWindow).workspace = testBridge.bridge;
    render(<WorkspaceConnectHost />);
    const request = { origin: 'argv', path: '/w/x' } as const;

    act(() => {
      testBridge.getOpenPathCallback()?.(request);
    });

    expect(connectPathMock).toHaveBeenCalledExactlyOnceWith(request);
  });
});
