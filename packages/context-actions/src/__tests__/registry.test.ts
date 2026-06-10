import { describe, expect, it } from 'vitest';
import { createActionRegistry } from '../registry';
import { type ActionOutcome, type ContextTarget, defineContextAction } from '../types';

const fileTarget: ContextTarget = {
  kind: 'file-entry',
  name: 'notes.md',
  relativePath: 'docs/notes.md',
  absolutePath: '/Users/dev/project/docs/notes.md',
  entryType: 'file',
  rootFolderId: '/Users/dev/project',
};

const webFileTarget: ContextTarget = {
  ...fileTarget,
  absolutePath: null,
  rootFolderId: 'root-uuid',
};

const chunkTarget: ContextTarget = { kind: 'chunk', id: 'c1', content: 'hello' };

const ok: ActionOutcome = { ok: true };

function makeActions() {
  return {
    copyName: defineContextAction({
      id: 'file.copy-name',
      label: 'Copy Name',
      group: 'copy',
      appliesTo: ['file-entry'] as const,
      requiredCapabilities: ['clipboard'] as const,
      run: async () => ok,
    }),
    copyFullPath: defineContextAction({
      id: 'file.copy-full-path',
      label: 'Copy Full Path',
      group: 'copy',
      appliesTo: ['file-entry'] as const,
      requiredCapabilities: ['clipboard'] as const,
      isVisible: (target) => target.absolutePath !== null,
      run: async () => ok,
    }),
    reveal: defineContextAction({
      id: 'file.reveal',
      label: 'Reveal in Finder',
      group: 'navigate',
      appliesTo: ['file-entry'] as const,
      requiredCapabilities: ['fs.reveal'] as const,
      isVisible: (target) => target.absolutePath !== null,
      run: async () => ok,
    }),
    copyContent: defineContextAction({
      id: 'collection.copy-content',
      label: 'Copy Content',
      group: 'copy',
      appliesTo: ['chunk'] as const,
      requiredCapabilities: ['clipboard'] as const,
      run: async () => ok,
    }),
  };
}

describe('createActionRegistry', () => {
  it('filters by appliesTo kind', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard', 'fs.reveal']),
      services: {},
    });
    const groups = registry.actionsFor(chunkTarget);
    const ids = groups.flatMap((group) => group.actions.map((action) => action.id));
    expect(ids).toEqual(['collection.copy-content']);
  });

  it('hides actions whose required capability is missing (web)', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard']),
      services: {},
    });
    const ids = registry
      .actionsFor(fileTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(ids).not.toContain('file.reveal');
    expect(ids).toContain('file.copy-name');
  });

  it('hides actions whose isVisible returns false (null absolutePath)', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard', 'fs.reveal']),
      services: {},
    });
    const ids = registry
      .actionsFor(webFileTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(ids).toEqual(['file.copy-name']);
  });

  it('orders groups tree → copy → navigate → inspect → danger and omits empty groups', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard', 'fs.reveal']),
      services: {},
    });
    const groups = registry.actionsFor(fileTarget);
    expect(groups.map((group) => group.group)).toEqual(['copy', 'navigate']);
  });

  it('merges surface-local actions and groups them with global ones', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: [actions.copyName],
      capabilities: new Set(['clipboard']),
      services: {},
    });
    const local = defineContextAction({
      id: 'local.expand',
      label: 'Expand',
      group: 'tree',
      appliesTo: ['file-entry'] as const,
      run: async () => ok,
    });
    const groups = registry.actionsFor(fileTarget, [local]);
    expect(groups.map((group) => group.group)).toEqual(['tree', 'copy']);
  });
});
