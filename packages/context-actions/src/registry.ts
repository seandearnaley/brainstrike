import type {
  ActionGroup,
  ActionServices,
  ActionShortcut,
  AnyContextAction,
  CapabilityKey,
  ContextTarget,
} from './types';

export interface GroupedActions {
  actions: AnyContextAction[];
  group: ActionGroup;
}

/** Serializable presentation projection for native or remote menu adapters. */
export interface ActionMenuItemDescriptor {
  enabled: boolean;
  group: ActionGroup;
  id: string;
  label: string;
  shortcut?: ActionShortcut;
}

export interface GroupedActionMenuDescriptors {
  actions: ActionMenuItemDescriptor[];
  group: ActionGroup;
}

export interface ActionRegistry {
  actionsFor: (
    target: ContextTarget,
    localActions?: readonly AnyContextAction[]
  ) => GroupedActions[];
  capabilities: ReadonlySet<CapabilityKey>;
  descriptorsFor: (
    target: ContextTarget,
    localActions?: readonly AnyContextAction[]
  ) => GroupedActionMenuDescriptors[];
  services: ActionServices;
}

const GROUP_ORDER: readonly ActionGroup[] = [
  'primary',
  'tree',
  'copy',
  'navigate',
  'inspect',
  'danger',
];

export interface CreateActionRegistryOptions {
  actions: readonly AnyContextAction[];
  capabilities: ReadonlySet<CapabilityKey>;
  services: ActionServices;
}

export function createActionRegistry({
  actions,
  capabilities,
  services,
}: CreateActionRegistryOptions): ActionRegistry {
  assertUniqueActionIds(actions);

  function isUsable(action: AnyContextAction, target: ContextTarget): boolean {
    if (!action.appliesTo.includes(target.kind)) {
      return false;
    }
    for (const capability of action.requiredCapabilities ?? []) {
      if (!capabilities.has(capability)) {
        return false;
      }
    }
    if (action.isVisible && !action.isVisible(target)) {
      return false;
    }
    return true;
  }

  function actionsFor(
    target: ContextTarget,
    localActions: readonly AnyContextAction[] = []
  ): GroupedActions[] {
    const combinedActions = [...actions, ...localActions];
    assertUniqueActionIds(combinedActions);
    const usable = combinedActions.filter((action) => isUsable(action, target));
    return GROUP_ORDER.map((group) => ({
      actions: usable.filter((action) => action.group === group),
      group,
    })).filter((grouped) => grouped.actions.length > 0);
  }

  function descriptorsFor(
    target: ContextTarget,
    localActions: readonly AnyContextAction[] = []
  ): GroupedActionMenuDescriptors[] {
    return actionsFor(target, localActions).map((group) => ({
      actions: group.actions.map((action) => {
        const label = typeof action.label === 'function' ? action.label(target) : action.label;
        return {
          enabled: action.isEnabled ? action.isEnabled(target) : true,
          group: action.group,
          id: action.id,
          label,
          ...(action.shortcut
            ? {
                shortcut: {
                  key: action.shortcut.key,
                  modifiers: [...action.shortcut.modifiers],
                },
              }
            : {}),
        };
      }),
      group: group.group,
    }));
  }

  return { actionsFor, capabilities, descriptorsFor, services };
}

function assertUniqueActionIds(actions: readonly AnyContextAction[]): void {
  const ids = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.id)) {
      throw new Error(`Duplicate context action id: ${action.id}`);
    }
    ids.add(action.id);
  }
}
