import type { ComponentType } from 'react';
import type { ActionOutcome, ActionServices, CapabilityKey, ContextTarget } from '../index.js';

/**
 * Commands extend the reused context-actions capability union with surfaces
 * that have no per-target context action today (a shell, the active git
 * surface, the workspace as a whole). Capability gating is identical to
 * context-actions: a command whose required capabilities are not present in the
 * app's capability set is HIDDEN — never rendered disabled, never a stub that
 * fails at invoke time.
 */
export type CommandCapability = CapabilityKey | 'shell' | 'git' | 'workspace';

/**
 * Determines ordering and section heading in the ⌘K palette. Distinct from
 * context-actions `ActionGroup` because the palette groups globally rather than
 * by right-clicked surface.
 */
export type CommandGroup = 'navigate' | 'thread' | 'file' | 'workspace' | 'danger';

export type CommandIcon = ComponentType<{ className?: string }>;

/**
 * The execution context handed to every command's `run`. `target` is the
 * surface focused when the palette opened (captured at open time); targetless
 * global commands ignore it. `services` and `capabilities` are the SAME objects
 * the app-shell builds for the context-action registry — single source of
 * truth, never rebuilt here.
 */
export interface CommandContext {
  readonly capabilities: ReadonlySet<CommandCapability>;
  readonly services: ActionServices;
  readonly target?: ContextTarget;
}

interface CommandBase {
  readonly group?: CommandGroup;
  readonly icon?: CommandIcon;
  /** Namespaced, stable id: 'thread.new', 'nav.settings', 'fs.reveal'. */
  readonly id: string;
  /** Data-shaped gating ⇒ HIDDEN (e.g. no compatible target captured). */
  readonly isAvailable?: (ctx: CommandContext) => boolean;
  /** Extra substrings the search matcher considers alongside the label. */
  readonly keywords?: readonly string[];
  /**
   * STATIC label — the palette indexes labels up front, so a command's label
   * cannot depend on the (possibly absent) target. Dynamic-label context
   * actions are materialized to a static string by the bridge.
   */
  readonly label: string;
  /** All MUST be present in `ctx.capabilities` or the command is HIDDEN. */
  readonly requiredCapabilities?: readonly CommandCapability[];
}

/** A command that does its work when chosen. */
export interface RunCommand extends CommandBase {
  readonly page?: never;
  readonly run: (ctx: CommandContext) => Promise<ActionOutcome>;
}

/** A follow-up list the palette shows in place of the root list. */
export interface CommandPage {
  readonly commands: readonly RunCommand[];
  /** Section heading over the page's commands. */
  readonly heading: string;
  readonly placeholder: string;
}

/**
 * A command that opens a page of further commands when chosen (Go to Tab…),
 * built from the context at that moment. Only the ⌘K palette can show one.
 */
export interface PageCommand extends CommandBase {
  readonly page: (ctx: CommandContext) => CommandPage;
  readonly run?: never;
}

export type Command = RunCommand | PageCommand;

export interface CommandRegistry {
  /** Commands runnable in this context: capability ⊆ ctx AND isAvailable. */
  available: (ctx: CommandContext) => readonly Command[];
  byId: (id: string) => Command | undefined;
  /** Every registered command, unfiltered (used by tests/diagnostics). */
  listAll: () => readonly Command[];
}
