import type { ViewFilterPresetPort } from '@brainstrike/state-store';
import type { ViewFilterPresetReply } from '@brainstrike/types';
import { parseViewFilterPresetRequest } from '@brainstrike/types/catalog-args';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';

const Preset = z.strictObject({
  createdAt: z.iso.datetime(),
  description: z.string().nullable(),
  excludes: z.array(z.string()),
  icon: z.enum([
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
  id: z.string(),
  includes: z.array(z.string()),
  isDefault: z.boolean(),
  name: z.string(),
  sortOrder: z.number().int(),
  updatedAt: z.iso.datetime(),
  useRegex: z.boolean(),
});
const Reply = z.strictObject({ deleted: z.boolean().optional(), presets: z.array(Preset) });
const METHOD = 'host/view-filter-presets';
export function serveViewFilterPresets(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: ViewFilterPresetPort
): { close(): Promise<void> } {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<ViewFilterPresetReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
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
      const result = Reply.parse(
        await sendCatalogRequest(connection, METHOD, parseViewFilterPresetRequest(request))
      );
      return {
        presets: result.presets,
        ...(result.deleted === undefined ? {} : { deleted: result.deleted }),
      };
    },
  };
}
