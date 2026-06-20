import type {
  ActionGroup,
  AnyContextAction,
  ContextTarget,
  ContextTargetKind,
} from '@brainstrike/context-actions';
import type { Command, CommandGroup } from './types';

/**
 * One-way projection: context-actions `ActionGroup` → palette `CommandGroup`.
 * The context menu remains the source of truth for target-bound operations;
 * this only governs where a bridged command sorts in the palette.
 *
 * Keyed by the CLOSED `ActionGroup` union so the mapping is EXHAUSTIVE: if
 * context-actions adds a new group (e.g. `'share'`), this becomes a compile
 * error here until it is mapped, rather than silently bucketing the new group
 * as `'workspace'`. There is intentionally no runtime fallback — a new,
 * unmapped group is a build break, not a silent coercion.
 */
const ACTION_GROUP_TO_COMMAND_GROUP: Record<ActionGroup, CommandGroup> = {
  tree: 'file',
  copy: 'file',
  navigate: 'navigate',
  inspect: 'workspace',
  danger: 'danger',
};

/**
 * Adapts a context-actions `ContextAction` into a palette `Command`, bound to
 * the target that is focused AT BRIDGE TIME. `getTarget()` is invoked EAGERLY
 * (once, here) and the resolved target is snapshotted into the returned
 * command's `run` closure — the command does NOT re-read the focused target
 * later. Because the command registry is immutable, the app MUST rebuild its
 * commands (re-run `bridgeActionToCommand`) whenever the focused target
 * changes for the palette to track it; in PR-6.1b the palette captures the
 * target at open time and rebuilds on open, so the snapshot is always current
 * for the session it is shown. One-way only: the palette projects context
 * actions, never the reverse, and never mutates the action system.
 *
 * Returns `null` when the action cannot run against the snapshotted target, so
 * the caller (the app command registry) simply drops it from the palette:
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
    group: ACTION_GROUP_TO_COMMAND_GROUP[action.group],
    ...(action.icon ? { icon: action.icon } : {}),
    ...(action.requiredCapabilities
      ? { requiredCapabilities: [...action.requiredCapabilities] }
      : {}),
    run: (ctx) => action.run(target, ctx.services),
  };
  return command;
}
