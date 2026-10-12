import { z } from 'zod';

/** Data-only workspace views; connected roots and execution authority are excluded. */
export const WorkspaceSnapshotSchema = z.strictObject({
  apps: z.strictObject({
    openAppIds: z.array(z.string()),
    selection: z.discriminatedUnion('kind', [
      z.strictObject({ appId: z.string(), kind: z.literal('app') }),
      z.strictObject({ kind: z.literal('file'), tabId: z.string() }),
      z.strictObject({ kind: z.literal('empty') }),
    ]),
  }),
  editors: z.record(
    z.string(),
    z.strictObject({
      mode: z.enum(['preview', 'source']).optional(),
      pane: z
        .strictObject({
          expandedPaths: z.array(z.string()).optional(),
          open: z.boolean(),
          widthPct: z.number().optional(),
        })
        .optional(),
      scrollTop: z.number().optional(),
    })
  ),
  explorer: z.strictObject({
    byRoot: z.record(z.string(), z.strictObject({ expandedPaths: z.array(z.string()) })),
    scrollTop: z.number().optional(),
  }),
  fileTabs: z.strictObject({
    activeTabId: z.string().nullable(),
    tabs: z.array(z.strictObject({ compositeKey: z.string(), path: z.string() })),
  }),
  roots: z.strictObject({
    focusedRootId: z.string().nullable(),
    visibleRootIds: z.array(z.string()).nullable(),
  }),
  version: z.literal(1),
});

export type WorkspaceSnapshotSelection =
  | { kind: 'app'; appId: string }
  | { kind: 'file'; tabId: string }
  | { kind: 'empty' };
export interface WorkspaceSnapshotFileTab {
  readonly compositeKey: string;
  readonly path: string;
}
export interface WorkspaceSnapshotPane {
  readonly expandedPaths?: readonly string[];
  readonly open: boolean;
  readonly widthPct?: number;
}
export interface WorkspaceSnapshotEditor {
  readonly mode?: 'preview' | 'source';
  readonly pane?: WorkspaceSnapshotPane;
  readonly scrollTop?: number;
}
export interface WorkspaceSnapshotV1 {
  readonly apps: {
    readonly openAppIds: readonly string[];
    readonly selection: WorkspaceSnapshotSelection;
  };
  readonly editors: Readonly<Record<string, WorkspaceSnapshotEditor>>;
  readonly explorer: {
    readonly scrollTop?: number;
    readonly byRoot: Readonly<Record<string, { readonly expandedPaths: readonly string[] }>>;
  };
  readonly fileTabs: {
    readonly activeTabId: string | null;
    readonly tabs: readonly WorkspaceSnapshotFileTab[];
  };
  readonly roots: {
    readonly focusedRootId: string | null;
    readonly visibleRootIds: readonly string[] | null;
  };
  readonly version: 1;
}
