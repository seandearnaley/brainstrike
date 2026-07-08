import type { ActionOutcome, AnyContextAction, ContextTarget } from '@brainstrike/context-actions';
import { createLogger } from '@brainstrike/utils';
import {
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from 'react';
import { toast } from '../use-toast';
import { useActionRegistry } from './action-registry-provider';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from './context-menu';

const logger = createLogger('ContextActions');

export interface ContextMenuTargetController {
  setTarget: (target: ContextTarget | null) => void;
  target: ContextTarget | null;
  targetRef: RefObject<ContextTarget | null>;
}

/**
 * Owns the "what was right-clicked" state. `setTarget` writes a ref
 * synchronously so the trigger wrapper can read it during the same
 * contextmenu event (row handlers run before the wrapper handler).
 *
 * The target is intentionally NOT cleared when the menu closes (clearing in
 * onOpenChange(false) can race a reopen). A stale target behind a closed menu
 * is inert; the surface resets it on the next right-click (see
 * ActionContextMenuProps.controller).
 *
 * The returned controller object is NOT referentially stable across renders
 * (only `setTarget` and `targetRef` are); memoized rows should depend on
 * `setTarget`, not the controller.
 */
export function useContextMenuTarget(): ContextMenuTargetController {
  const [target, setTargetState] = useState<ContextTarget | null>(null);
  const targetRef = useRef<ContextTarget | null>(null);
  const setTarget = useCallback((next: ContextTarget | null) => {
    targetRef.current = next;
    setTargetState(next);
  }, []);
  return { setTarget, target, targetRef };
}

export interface ActionContextMenuProps {
  children: ReactNode;
  /**
   * Convention: the direct child surface MUST attach
   * `onContextMenuCapture={() => controller.setTarget(null)}` so every
   * right-click starts with a clean target before row handlers claim it.
   */
  controller: ContextMenuTargetController;
  localActions?: readonly AnyContextAction[];
}

export function ActionContextMenu({ controller, localActions, children }: ActionContextMenuProps) {
  const registry = useActionRegistry();
  const { target, targetRef } = controller;
  const groups = target ? registry.actionsFor(target, localActions) : [];

  const handleRun = useCallback(
    (action: AnyContextAction, currentTarget: ContextTarget) => {
      const onOutcome = (outcome: ActionOutcome): void => {
        if (outcome.ok) {
          if (outcome.message) {
            toast({ description: outcome.message });
          }
          return;
        }
        logger.error('Context action failed', {
          actionId: action.id,
          error: outcome.error,
          targetKind: currentTarget.kind,
        });
        toast({
          description: outcome.error,
          title: 'Action failed',
          variant: 'destructive',
        });
      };
      // Surfacing boundary, not a fallback: the action contract says `run`
      // resolves an ActionOutcome, so a throwing/rejecting action is a bug —
      // surface it loudly instead of letting it escape into Radix's onSelect
      // dispatch (sync throw) or die as an unhandled rejection (async).
      const onUnexpected = (error: unknown): void => {
        logger.error('Context action threw', {
          actionId: action.id,
          error,
          targetKind: currentTarget.kind,
        });
        toast({
          description: error instanceof Error ? error.message : String(error),
          title: 'Action failed unexpectedly',
          variant: 'destructive',
        });
      };
      try {
        void action.run(currentTarget, registry.services).then(onOutcome).catch(onUnexpected);
      } catch (error) {
        onUnexpected(error);
      }
    },
    [registry.services]
  );

  const handleWrapperContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      // The surface resets the target in a capture-phase handler, then row
      // handlers (inner, bubble) claim it by calling setTarget. By the time
      // this outer handler runs, a null ref means "no row claimed this
      // right-click" — prevent default so Radix does not open an empty menu.
      // A claimed target can ALSO yield zero actions (capability gating, or a
      // registry with nothing applicable to this kind) — veto that at event
      // time too, so an empty menu box never opens.
      const claimed = targetRef.current;
      if (!claimed || registry.actionsFor(claimed, localActions).length === 0) {
        event.preventDefault();
      }
    },
    [targetRef, registry, localActions]
  );

  // Known limitation (desktop-first): Radix opens context menus from
  // touch/pen long-press (~700ms) without a native `contextmenu` event, so the
  // capture-reset + row-claim protocol never runs on touch — the menu can open
  // against a stale (or null) target there.
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: layout-neutral trigger wrapper; the handler only vetoes Radix's open for unclaimed right-clicks */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: see above — `display: contents` wrapper, not an interactive control */}
        <div
          className="contents"
          data-testid="action-context-menu-trigger"
          onContextMenu={handleWrapperContextMenu}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-60">
        {target
          ? groups.map((group, groupIndex) => (
              <Fragment key={group.group}>
                {groupIndex > 0 ? <ContextMenuSeparator /> : null}
                {group.actions.map((action) => {
                  const label =
                    typeof action.label === 'function' ? action.label(target) : action.label;
                  const Icon = action.icon;
                  const enabled = action.isEnabled ? action.isEnabled(target) : true;
                  return (
                    <ContextMenuItem
                      disabled={!enabled}
                      key={action.id}
                      onSelect={() => handleRun(action, target)}
                    >
                      {Icon ? <Icon className="mr-2 h-4 w-4" /> : null}
                      {label}
                    </ContextMenuItem>
                  );
                })}
              </Fragment>
            ))
          : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
