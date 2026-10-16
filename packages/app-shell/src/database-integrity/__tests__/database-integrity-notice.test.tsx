import { INTERNAL_FAULT } from '@brainstrike/assistant-contract/boundary-failure';
import type { DesktopDatabaseIntegrityBridge } from '@brainstrike/db';
import type { DatabaseIntegrityContext, DatabaseIntegritySnapshot } from '@brainstrike/types';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@brainstrike/logging', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/logging')>()),
  createLogger: () => loggerMock,
}));

import { DatabaseIntegrityNotice } from '../database-integrity-notice';

const SINCE = '2026-09-29T14:03:07.000Z';
const PG_MESSAGE = 'invalid page in block 42 of relation base/16384/1259';

function healthy(revision: number): DatabaseIntegritySnapshot {
  return { revision, state: { kind: 'healthy' } };
}

function contained(
  revision: number,
  context: DatabaseIntegrityContext = 'db:query'
): DatabaseIntegritySnapshot {
  return {
    revision,
    state: {
      context,
      kind: 'contained',
      signal: { message: PG_MESSAGE, sqlstate: 'XX001' },
      since: SINCE,
    },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

/** Flushes every microtask the watcher and the store chain behind one bridge call. */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

interface FakeBridge {
  readonly bridge: DesktopDatabaseIntegrityBridge;
  readonly emit: (snapshot: DatabaseIntegritySnapshot) => void;
  readonly getState: ReturnType<typeof vi.fn<DesktopDatabaseIntegrityBridge['getState']>>;
  readonly listenerCount: () => number;
}

function createFakeBridge(read: () => Promise<DatabaseIntegritySnapshot>): FakeBridge {
  const listeners = new Set<(snapshot: DatabaseIntegritySnapshot) => void>();
  const getState = vi.fn<DesktopDatabaseIntegrityBridge['getState']>(() =>
    read().then((value) => ({ ok: true as const, value }))
  );
  return {
    bridge: {
      getState,
      onChanged: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
    },
    emit: (snapshot) => {
      act(() => {
        for (const listener of [...listeners]) {
          listener(snapshot);
        }
      });
    },
    getState,
    listenerCount: () => listeners.size,
  };
}

type IntegrityWindow = Window & { databaseIntegrity?: DesktopDatabaseIntegrityBridge | undefined };

function exposeBridge(bridge: DesktopDatabaseIntegrityBridge): void {
  (window as IntegrityWindow).databaseIntegrity = bridge;
}

const COPY_MESSAGE =
  'Background indexing is paused because BrainStrike found a problem in its local database. Nothing was deleted or replaced.';

describe('DatabaseIntegrityNotice', () => {
  afterEach(() => {
    (window as IntegrityWindow).databaseIntegrity = undefined;
    loggerMock.error.mockClear();
  });

  it('shows the status-unreadable alert, never throws, for a state kind this renderer does not know', async () => {
    // A newer main (a future `repairing` state) or a malformed payload must not take the shell down.
    const unknown = {
      revision: 2,
      state: { kind: 'repairing' },
    } as unknown as DatabaseIntegritySnapshot;
    exposeBridge(createFakeBridge(() => Promise.resolve(unknown)).bridge);

    render(<DatabaseIntegrityNotice />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("BrainStrike couldn't read the database status");
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Unknown database integrity state; showing the status as unreadable',
      { kind: 'repairing', revision: 2 }
    );
  });

  it('logs an unknown state once per snapshot, never once per render', async () => {
    const unknown = {
      revision: 2,
      state: { kind: 'repairing' },
    } as unknown as DatabaseIntegritySnapshot;
    exposeBridge(createFakeBridge(() => Promise.resolve(unknown)).bridge);

    const view = render(
      <StrictMode>
        <DatabaseIntegrityNotice />
      </StrictMode>
    );
    await screen.findByRole('alert');
    view.rerender(
      <StrictMode>
        <DatabaseIntegrityNotice />
      </StrictMode>
    );
    view.rerender(
      <StrictMode>
        <DatabaseIntegrityNotice />
      </StrictMode>
    );

    expect(loggerMock.error).toHaveBeenCalledTimes(1);
  });

  it('shows the raw first-seen value when it is not a valid date', async () => {
    const snapshot = contained(1);
    const invalid = {
      ...snapshot,
      state: { ...snapshot.state, since: 'not-a-date' },
    } as DatabaseIntegritySnapshot;
    exposeBridge(createFakeBridge(() => Promise.resolve(invalid)).bridge);

    render(<DatabaseIntegrityNotice />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('not-a-date');
    expect(alert).not.toHaveTextContent('Invalid Date');
  });

  it('renders nothing when the desktop integrity capability is absent', async () => {
    const { container } = render(<DatabaseIntegrityNotice />);
    await settle();

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a healthy database', async () => {
    const fake = createFakeBridge(() => Promise.resolve(healthy(1)));
    exposeBridge(fake.bridge);

    const { container } = render(<DatabaseIntegrityNotice />);
    await settle();

    expect(fake.getState).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the containment alert with the plain-language message when the first read is contained', async () => {
    exposeBridge(createFakeBridge(() => Promise.resolve(contained(1))).bridge);

    render(<DatabaseIntegrityNotice />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(COPY_MESSAGE);
    expect(alert).toHaveAttribute('data-slot', 'database-integrity-notice');
    expect(alert).toHaveAttribute('data-testid', 'database-integrity-notice');
  });

  it('keeps the technical details behind a closed disclosure and reveals them on open', async () => {
    exposeBridge(createFakeBridge(() => Promise.resolve(contained(1))).bridge);
    render(<DatabaseIntegrityNotice />);
    const alert = await screen.findByRole('alert');

    const summary = within(alert).getByText('Details');
    const details = summary.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(within(alert).getByText('XX001')).not.toBeVisible();

    fireEvent.click(summary);

    expect(within(alert).getByText('a database query')).toBeVisible();
    expect(within(alert).getByText('XX001')).toBeVisible();
    expect(within(alert).getByText(PG_MESSAGE)).toBeVisible();
    const time = within(alert).getByText(new Date(SINCE).toLocaleString());
    expect(time).toBeVisible();
    expect(time).toHaveAttribute('datetime', SINCE);
    expect(within(alert).getByText('Restart BrainStrike to resume indexing.')).toBeVisible();
  });

  it.each<[DatabaseIntegrityContext, string]>([
    ['db:query', 'a database query'],
    ['maintenance', 'scheduled maintenance'],
    ['assistant:reindex', 'assistant file re-indexing'],
    ['db:exec', 'db:exec'],
  ])('describes the %s context as "%s"', async (context, phrase) => {
    exposeBridge(createFakeBridge(() => Promise.resolve(contained(1, context))).bridge);
    render(<DatabaseIntegrityNotice />);

    const alert = await screen.findByRole('alert');

    expect(within(alert).getByText(phrase)).toBeInTheDocument();
  });

  it('removes the alert when main publishes a healthy snapshot', async () => {
    const fake = createFakeBridge(() => Promise.resolve(contained(1)));
    exposeBridge(fake.bridge);
    render(<DatabaseIntegrityNotice />);
    await screen.findByRole('alert');

    fake.emit(healthy(2));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the alert when main publishes containment after a healthy first read', async () => {
    const fake = createFakeBridge(() => Promise.resolve(healthy(1)));
    exposeBridge(fake.bridge);
    render(<DatabaseIntegrityNotice />);
    await settle();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fake.emit(contained(2));

    expect(screen.getByRole('alert')).toHaveTextContent(COPY_MESSAGE);
  });

  it('keeps a newer pushed snapshot when the first read resolves later with a stale one', async () => {
    const read = deferred<DatabaseIntegritySnapshot>();
    const fake = createFakeBridge(() => read.promise);
    exposeBridge(fake.bridge);
    render(<DatabaseIntegrityNotice />);
    await settle();

    fake.emit(contained(2));
    read.resolve(healthy(1));
    await settle();

    expect(screen.getByRole('alert')).toHaveTextContent(COPY_MESSAGE);
  });

  it('ignores a stale lower-revision push after a newer snapshot', async () => {
    const fake = createFakeBridge(() => Promise.resolve(contained(5)));
    exposeBridge(fake.bridge);
    render(<DatabaseIntegrityNotice />);
    await screen.findByRole('alert');

    fake.emit(healthy(3));

    expect(screen.getByRole('alert')).toHaveTextContent(COPY_MESSAGE);
  });

  it('shows the status-unreadable message, never healthy, when the first read fails', async () => {
    const fake = createFakeBridge(() => Promise.reject(new Error('ipc closed')));
    exposeBridge(fake.bridge);
    render(<DatabaseIntegrityNotice />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("BrainStrike couldn't read the database status.");
    expect(alert).not.toHaveTextContent(COPY_MESSAGE);
    expect(loggerMock.error).toHaveBeenCalledWith('Could not read the database integrity state', {
      error: expect.objectContaining({
        cause: expect.objectContaining({ message: 'ipc closed' }),
        message: INTERNAL_FAULT.message,
      }),
    });

    fake.emit(healthy(1));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a pushed state when the first read then fails: the push is a known state', async () => {
    const read = deferred<DatabaseIntegritySnapshot>();
    const fake = createFakeBridge(() => read.promise);
    exposeBridge(fake.bridge);
    render(<DatabaseIntegrityNotice />);
    await settle();

    fake.emit(contained(2));
    read.reject(new Error('ipc closed'));
    await settle();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(COPY_MESSAGE);
    expect(alert).not.toHaveTextContent("couldn't read");
    expect(loggerMock.error).toHaveBeenCalledWith('Desktop IPC transport failed', {
      cause: expect.objectContaining({ message: 'ipc closed' }),
    });
    expect(loggerMock.error).toHaveBeenCalledWith('Could not read the database integrity state', {
      error: expect.objectContaining({ message: INTERNAL_FAULT.message }),
    });
    expect(loggerMock.error).toHaveBeenCalledTimes(2);
  });

  it('reads once under StrictMode double subscription', async () => {
    const fake = createFakeBridge(() => Promise.resolve(contained(1)));
    exposeBridge(fake.bridge);

    render(
      <StrictMode>
        <DatabaseIntegrityNotice />
      </StrictMode>
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(COPY_MESSAGE);
    expect(fake.getState).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(1);
  });

  it('reads once per renderer: a remount reuses the watcher and shows the held state at once', async () => {
    const fake = createFakeBridge(() => Promise.resolve(contained(1)));
    exposeBridge(fake.bridge);
    const first = render(<DatabaseIntegrityNotice />);
    await screen.findByRole('alert');
    first.unmount();

    render(<DatabaseIntegrityNotice />);

    expect(screen.getByRole('alert')).toHaveTextContent(COPY_MESSAGE);
    expect(fake.getState).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(1);
  });
});
