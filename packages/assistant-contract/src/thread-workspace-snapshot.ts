import { Schema } from 'effect';
/** Data-only workspace views; connected roots and execution authority are excluded. */
export const WorkspaceSnapshotSchema = Schema.Struct({
  apps: Schema.Struct({
    openAppIds: Schema.mutable(Schema.Array(Schema.String)),
    selection: Schema.Union(
      [
        Schema.Struct({ appId: Schema.String, kind: Schema.Literal('app') }),
        Schema.Struct({ kind: Schema.Literal('file'), tabId: Schema.String }),
        Schema.Struct({ kind: Schema.Literal('empty') }),
      ],
      { mode: 'oneOf' }
    ),
  }),
  editors: Schema.Record(
    Schema.String,
    Schema.Struct({
      mode: Schema.optional(Schema.Literals(['preview', 'source'])),
      pane: Schema.optional(
        Schema.Struct({
          expandedPaths: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
          open: Schema.Boolean,
          widthPct: Schema.optional(Schema.Finite),
        })
      ),
      scrollTop: Schema.optional(Schema.Finite),
    })
  ),
  explorer: Schema.Struct({
    byRoot: Schema.Record(
      Schema.String,
      Schema.Struct({ expandedPaths: Schema.mutable(Schema.Array(Schema.String)) })
    ),
    scrollTop: Schema.optional(Schema.Finite),
  }),
  fileTabs: Schema.Struct({
    activeTabId: Schema.NullOr(Schema.String),
    tabs: Schema.mutable(
      Schema.Array(Schema.Struct({ compositeKey: Schema.String, path: Schema.String }))
    ),
  }),
  roots: Schema.Struct({
    focusedRootId: Schema.NullOr(Schema.String),
    visibleRootIds: Schema.NullOr(Schema.mutable(Schema.Array(Schema.String))),
  }),
  version: Schema.Literal(1),
});
export type WorkspaceSnapshotSelection =
  | {
      kind: 'app';
      appId: string;
    }
  | {
      kind: 'file';
      tabId: string;
    }
  | {
      kind: 'empty';
    };
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
    readonly byRoot: Readonly<
      Record<
        string,
        {
          readonly expandedPaths: readonly string[];
        }
      >
    >;
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
