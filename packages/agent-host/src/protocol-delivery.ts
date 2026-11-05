/** What a run delivers to its thread's model that no person typed (BST-1932). */
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));

/** One settled background invocation delivered to its parent (BST-1932). */
export const HostChildDeliveryEntrySchema = Schema.Struct({
  childRunId: Id,
  childThreadId: Id,
  followUp: Schema.optional(Schema.Literal(true)),
  outcome: Schema.String,
  parentRunId: Id,
  state: Schema.Literals(['returned', 'failed', 'cancelled']),
  toolCallId: Id,
});
export type HostChildDeliveryEntry = (typeof HostChildDeliveryEntrySchema)['Type'];
/** A command session a run started that ended by itself, delivered with the thread's next run. */
export const HostCommandSessionDeliverySchema = Schema.Struct({
  exitCode: Schema.Int,
  rootId: Id,
  sessionId: Id,
  signal: Schema.NullOr(Schema.Int),
  threadId: Id,
});
export type HostCommandSessionDelivery = (typeof HostCommandSessionDeliverySchema)['Type'];
/**
 * ADR-0028 step 3b: what a thread is told that no person typed, posted once on
 * that thread's log by the commit that settles it, and taken by the run whose
 * `delivery` names it, along that run's own branch.
 */
export const HostNoticeSchema = Schema.Union(
  [
    /** A child run's report to the thread that delegated it: its parent's ledger outlives the child. */
    Schema.Struct({
      entry: HostChildDeliveryEntrySchema,
      kind: Schema.Literal('child'),
      persona: Id,
      prompt: Schema.String,
      reason: Schema.optional(Schema.String),
      toolName: Id,
      /** The parent turn that dispatched an invocation; a follow-up's report has none. */
      turnId: Schema.optional(Id),
    }),
    /** A command session that ended by itself, told to the thread that hears it. */
    Schema.Struct({
      createdAt: Schema.Int,
      exitedAt: Schema.Int,
      /** The idle child thread it was first told to, which handed it on. */
      handedOnFrom: Schema.optional(Id),
      kind: Schema.Literal('command-session'),
      outputCursor: Schema.Int,
      session: HostCommandSessionDeliverySchema,
    }),
  ],
  { mode: 'oneOf' }
);
export type HostNotice = (typeof HostNoticeSchema)['Type'];
/**
 * The durable delivery watermark: these entries reached the parent's model
 * input on the run that records them, as an automated message that the user
 * did not write. A wake run's prompt is that message; a user turn carries it
 * ahead of its own message.
 */
/** Ended command sessions; a delivery may carry only these, with no child entries. */
const CommandSessions = Schema.optional(
  Schema.mutable(Schema.Array(HostCommandSessionDeliverySchema)).check(Schema.isMinLength(1))
);
export const HostChildDeliverySchema = Schema.Union(
  [
    Schema.Struct({
      commandSessions: CommandSessions,
      entries: Schema.mutable(Schema.Array(HostChildDeliveryEntrySchema)),
      messageId: Id,
      turnId: Id,
      via: Schema.Literal('wake'),
    }),
    Schema.Struct({
      commandSessions: CommandSessions,
      entries: Schema.mutable(Schema.Array(HostChildDeliveryEntrySchema)),
      ledger: Id,
      messageId: Id,
      via: Schema.Literal('next-turn'),
    }).check(
      Schema.makeFilter((delivery) =>
        delivery.entries.length > 0 || delivery.commandSessions
          ? undefined
          : { issue: 'A next-turn delivery delivers nothing', path: [] }
      )
    ),
  ],
  { mode: 'oneOf' }
);
export type HostChildDelivery = (typeof HostChildDeliverySchema)['Type'];
