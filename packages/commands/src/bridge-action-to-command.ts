import type {
  AnyContextAction,
  ContextTarget,
  ContextTargetKind,
} from '@brainstrike/context-actions';
import type { Command, CommandGroup } from './types';

/**
 * One-way projection: context-actions `ActionGroup` → palette `CommandGroup`.
 * The context menu remains the source of truth for target-bound operations;
 * this only governs where a bridged command sorts in the palette.
 */
const ACTION_GROUP_TO_COMMAND_GROUP: Record<string, CommandGroup> = {
  tree: 'file',
  copy: 'file',
  navigate: 'navigate',
  inspect: 'workspace',
  danger: 'danger',
};

function resolveCommandGroup(actionGroup: string): CommandGroup {
  return ACTION_GROUP_TO_COMMAND_GROUP[actionGroup] ?? 'workspace';
}

/**
 * Adapts a context-actions `ContextAction` into a palette `Command`, bound to
 * the CURRENTLY-focused target (resolved lazily via `getTarget`). One-way only:
 * the palette projects context actions, never the reverse, and never mutates
 * the action system.
 *
 * Returns `null` when the action cannot run against the present target, so the
 * caller (the app command registry) simply drops it from the palette:
 *  - no target captured at all;
 *  - the action does not apply to the target's kind (`appliesTo`);
 *  - the action's data-shaped `isVisible` gate fails for this target.
 *
 * The command's label is materialized to a STATIC string at bridge time: a
 * dynamic-label action (`label: (target) => string`) is evaluated once against
 * the resolved target, because the palette indexes labels eagerly and cannot
 * re-evaluate them per render. Capability requirements pass through unchanged
 * (`CapabilityKey` is a subset of `CommandCapability`), so the registry's
 * capability gating hides a bridged command exactly as the context menu does.
 */
export function bridgeActionToCommand(
  action: AnyContextAction,
  getTarget: () => ContextTarget | null | undefined
): Command | null {
  const target = getTarget();
  if (!target) {
    return null;
  }
  if (!action.appliesTo.includes(target.kind as ContextTargetKind)) {
    return null;
  }
  if (action.isVisible && !action.isVisible(target)) {
    return null;
  }

  const label = typeof action.label === 'function' ? action.label(target) : action.label;

  const command: Command = {
    id: action.id,
    label,
    group: resolveCommandGroup(action.group),
    ...(action.icon ? { icon: action.icon } : {}),
    ...(action.requiredCapabilities
      ? { requiredCapabilities: [...action.requiredCapabilities] }
      : {}),
    run: (ctx) => action.run(target, ctx.services),
  };
  return command;
}
