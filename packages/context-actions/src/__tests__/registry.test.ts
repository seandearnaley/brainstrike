import { describe, expect, it } from 'vitest';
import { createActionRegistry } from '../registry';
import { type ActionOutcome, type ContextTarget, defineContextAction } from '../types';

const fileTarget: ContextTarget = {
  absolutePath: '/Users/dev/project/docs/notes.md',
  entryType: 'file',
  kind: 'file-entry',
  name: 'notes.md',
  relativePath: 'docs/notes.md',
  rootFolderId: '/Users/dev/project',
};

const webFileTarget: ContextTarget = {
  ...fileTarget,
  absolutePath: null,
  rootFolderId: 'root-uuid',
};

const chunkTarget: ContextTarget = { content: 'hello', id: 'c1', kind: 'chunk' };

const ok: ActionOutcome = { ok: true };

function makeActions() {
  return {
    copyContent: defineContextAction({
      appliesTo: ['chunk'] as const,
      group: 'copy',
      id: 'collection.copy-content',
      label: 'Copy Content',
      requiredCapabilities: ['clipboard'] as const,
      run: async () => ok,
    }),
    copyFullPath: defineContextAction({
      appliesTo: ['file-entry'] as const,
      group: 'copy',
      id: 'file.copy-full-path',
      isVisible: (target) => target.absolutePath !== null,
      label: 'Copy Full Path',
      requiredCapabilities: ['clipboard'] as const,
      run: async () => ok,
    }),
    copyName: defineContextAction({
      appliesTo: ['file-entry'] as const,
      group: 'copy',
      id: 'file.copy-name',
      label: 'Copy Name',
      requiredCapabilities: ['clipboard'] as const,
      run: async () => ok,
    }),
    reveal: defineContextAction({
      appliesTo: ['file-entry'] as const,
      group: 'navigate',
      id: 'file.reveal',
      isVisible: (target) => target.absolutePath !== null,
      label: 'Reveal in Finder',
      requiredCapabilities: ['fs.reveal'] as const,
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

  it('orders groups primary → tree → copy → navigate → inspect → danger and omits empty groups', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: Object.values(actions),
      capabilities: new Set(['clipboard', 'fs.reveal']),
      services: {},
    });
    const groups = registry.actionsFor(fileTarget);
    expect(groups.map((group) => group.group)).toEqual(['copy', 'navigate']);
  });

  it('does not filter on isEnabled — disabled actions remain listed', () => {
    const disabled = defineContextAction({
      appliesTo: ['file-entry'] as const,
      group: 'copy',
      id: 'file.disabled',
      isEnabled: () => false,
      label: 'Disabled Action',
      run: async () => ok,
    });
    const registry = createActionRegistry({
      actions: [disabled],
      capabilities: new Set(['clipboard']),
      services: {},
    });
    const ids = registry
      .actionsFor(fileTarget)
      .flatMap((group) => group.actions.map((action) => action.id));
    expect(ids).toEqual(['file.disabled']);
  });

  it('merges surface-local actions and groups them with global ones', () => {
    const actions = makeActions();
    const registry = createActionRegistry({
      actions: [actions.copyName],
      capabilities: new Set(['clipboard']),
      services: {},
    });
    const local = defineContextAction({
      appliesTo: ['file-entry'] as const,
      group: 'tree',
      id: 'local.expand',
      label: 'Expand',
      run: async () => ok,
    });
    const primary = defineContextAction({
      appliesTo: ['file-entry'] as const,
      group: 'primary',
      id: 'local.open',
      label: 'Open',
      run: async () => ok,
    });
    const groups = registry.actionsFor(fileTarget, [local, primary]);
    expect(groups.map((group) => group.group)).toEqual(['primary', 'tree', 'copy']);
  });
});
