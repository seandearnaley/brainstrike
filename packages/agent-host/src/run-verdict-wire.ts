import { Schema } from 'effect';
/** Committed run labels shared by host events and the Task Ledger read model. */
export const RunVerdictSchema = Schema.Literals(['failed', 'mixed', 'succeeded']);
export const RunVerdictSourceSchema = Schema.Literals(['edit_revert', 'hook', 'user']);
export const RunVerdictDetailSchema = Schema.String.check(Schema.isMaxCodePoints(2000));
