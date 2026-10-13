import { z } from 'zod';

/** Committed run labels shared by host events and the Task Ledger read model. */
export const RunVerdictSchema = z.enum(['failed', 'mixed', 'succeeded']);
export const RunVerdictSourceSchema = z.enum(['edit_revert', 'hook', 'user']);
export const RunVerdictDetailSchema = z.string().max(2000);
