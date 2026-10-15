// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  readThreadCanvasSummaries,
  readThreadCanvasVersion,
} from '../canvas/canvas-read-repository';

const NOT_OWNED = /not owned by the agent host/;

describe('canvas read repository', () => {
  it('reads a host-owned thread from its host, and refuses a thread the host does not own', async () => {
    const plan = (version: number, createdAt: string) => ({
      canvasId: 'plan',
      createdAt,
      createdBy: 'assistant',
      html: `<p>plan v${version}</p>`,
      title: `Plan v${version}`,
      version,
    });
    const notes = {
      canvasId: 'notes',
      createdAt: '2026-10-08T10:00:00.000Z',
      createdBy: 'user',
      html: '<p>notes</p>',
      title: 'Notes',
      version: 1,
    };
    const host = {
      readCanvases: async (threadId: string) =>
        threadId === 'host-thread'
          ? new Map([
              ['plan', [plan(1, '2026-10-08T09:00:00.000Z'), plan(2, '2026-10-08T11:00:00.000Z')]],
              ['notes', [notes]],
            ])
          : undefined,
    };

    await expect(readThreadCanvasSummaries(host, 'host-thread')).resolves.toEqual([
      {
        canvasId: 'plan',
        createdAt: '2026-10-08T11:00:00.000Z',
        latestVersion: 2,
        title: 'Plan v2',
      },
      {
        canvasId: 'notes',
        createdAt: '2026-10-08T10:00:00.000Z',
        latestVersion: 1,
        title: 'Notes',
      },
    ]);
    await expect(readThreadCanvasVersion(host, 'host-thread', 'plan', 1)).resolves.toEqual({
      createdAt: '2026-10-08T09:00:00.000Z',
      createdBy: 'assistant',
      html: '<p>plan v1</p>',
      version: 1,
    });
    await expect(readThreadCanvasVersion(host, 'host-thread', 'plan', 3)).resolves.toBeNull();

    await expect(readThreadCanvasSummaries(host, 'other-thread')).rejects.toThrow(NOT_OWNED);
    await expect(readThreadCanvasVersion(host, 'other-thread', 'plan', 1)).rejects.toThrow(
      NOT_OWNED
    );
  });

  it('refuses every read without a host that serves canvases', async () => {
    await expect(readThreadCanvasSummaries(undefined, 'thread-1')).rejects.toThrow(NOT_OWNED);
    await expect(readThreadCanvasVersion({}, 'thread-1', 'plan', 1)).rejects.toThrow(NOT_OWNED);
  });
});
