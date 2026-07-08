import type {
  ActionGroup,
  ActionServices,
  AnyContextAction,
  CapabilityKey,
  ContextTarget,
} from './types';

export interface GroupedActions {
  actions: AnyContextAction[];
  group: ActionGroup;
}

export interface ActionRegistry {
  actionsFor: (
    target: ContextTarget,
    localActions?: readonly AnyContextAction[]
  ) => GroupedActions[];
  capabilities: ReadonlySet<CapabilityKey>;
  services: ActionServices;
}

const GROUP_ORDER: readonly ActionGroup[] = ['tree', 'copy', 'navigate', 'inspect', 'danger'];

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
    const usable = [...actions, ...localActions].filter((action) => isUsable(action, target));
    return GROUP_ORDER.map((group) => ({
      actions: usable.filter((action) => action.group === group),
      group,
    })).filter((grouped) => grouped.actions.length > 0);
  }

  return { actionsFor, capabilities, services };
}
