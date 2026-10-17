import type { ViewFilterPresetPort } from '@brainstrike/state-store';
import type { ViewFilterPresetReply } from '@brainstrike/types';
import { parseViewFilterPresetRequest } from '@brainstrike/types/catalog-args';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';

const Preset = Schema.Struct({
  createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
  description: Schema.NullOr(Schema.String),
  excludes: Schema.mutable(Schema.Array(Schema.String)),
  icon: Schema.Literals([
    'file',
    'file-code',
    'file-text',
    'folder',
    'folder-open',
    'code',
    'settings',
    'database',
    'box',
    'user',
    'layout',
    'globe',
    'cpu',
    'palette',
    'flask-conical',
    'test-tube',
  ]),
  id: Schema.String,
  includes: Schema.mutable(Schema.Array(Schema.String)),
  isDefault: Schema.Boolean,
  name: Schema.String,
  sortOrder: Schema.Int,
  updatedAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
  useRegex: Schema.Boolean,
});
const Reply = Schema.Struct({
  deleted: Schema.optional(Schema.Boolean),
  presets: Schema.mutable(Schema.Array(Preset)),
});
const METHOD = 'host/view-filter-presets';
export function serveViewFilterPresets(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: ViewFilterPresetPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<ViewFilterPresetReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing !== undefined) {
      throw new Error('Preset endpoint is closing');
    }
    const work = store.viewFilterPresets(parseViewFilterPresetRequest(input));
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  });
  return {
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        while (pending.size > 0) {
          await Promise.allSettled([...pending]);
        }
        subscription.dispose();
      });
      return closing;
    },
  };
}
export function createViewFilterPresetClient(connection: MessageConnection): ViewFilterPresetPort {
  return {
    viewFilterPresets: async (request) => {
      const result = Schema.decodeUnknownSync(Reply, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(connection, METHOD, parseViewFilterPresetRequest(request))
      );
      return {
        presets: result.presets,
        ...(result.deleted === undefined ? {} : { deleted: result.deleted }),
      };
    },
  };
}
