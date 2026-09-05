import { z } from 'zod';
import {
  MAX_EXEC_CODE_LENGTH,
  MAX_EXEC_TIMEOUT_MS,
  MAX_POLICY_ENTRIES,
  policyDomainSchema,
} from './exec-policy-domain.js';
import { providerCompatibleInputSchema } from './provider-compatible-input.js';

export const ExecuteCommandInputSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(10_000)
      .describe('Shell command passed verbatim to `-c`; NO sandbox'),
    cwd: z
      .string()
      .optional()
      .describe('Start directory, absolute or root-relative; must resolve inside an open folder'),
    root: z
      .string()
      .optional()
      .describe('Open-folder name/id; required only with multiple folders'),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(600_000)
      .optional()
      .describe('Process-tree timeout ms (default 120000, max 600000)'),
  })
  .strict();

export type ExecuteCommandInput = z.infer<typeof ExecuteCommandInputSchema>;

const StrictRootRelativePathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      value === '.' ||
      (!(value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)) &&
        value
          .split('/')
          .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')),
    'Must be a canonical root-relative path without traversal'
  );

/**
 * run_python's domain grammar: the seam's `policyDomainSchema` PLUS a
 * public-host requirement (#2225 review). The generic policy grammar accepts
 * anything hostname-shaped, which includes `localhost`, bare IPv4 literals
 * (`127.0.0.1`, `192.168.1.10`, `169.254.169.254`), and mDNS `.local` names —
 * all of which the escalation card would present as "the internet" while the
 * actual grant is services on the user's own machine or network (a local
 * Ollama, a dev database, a cloud metadata endpoint). Model-authored code
 * gets no such grant: name a public domain or run offline.
 */
const IPV4_LITERAL_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const runPythonDomainSchema = policyDomainSchema
  .refine((value) => !IPV4_LITERAL_PATTERN.test(value), {
    message: 'IP literals are not allowed; name a public domain',
  })
  .refine(
    (value) => {
      const host = value.startsWith('*.') ? value.slice(2) : value;
      return !(
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === 'local' ||
        host.endsWith('.local')
      );
    },
    { message: 'localhost and .local addresses are not allowed; name a public domain' }
  );

export const RunPythonInputSchema = providerCompatibleInputSchema(
  z
    .object({
      allowedDomains: z
        .array(runPythonDomainSchema)
        // No .min(1): OpenAI's strict function-calling emits EVERY declared
        // property, so an offline call must be representable as an explicit
        // empty array (#2225 review). [] and omitted both mean no network.
        .max(MAX_POLICY_ENTRIES)
        .optional()
        .describe(
          'Public domains the script may reach, by name (e.g. "pypi.org", "*.example.com"); [] or omitted for no network. IP literals, localhost, and .local are not allowed. Each domain requires explicit user approval per call.'
        ),
      code: z
        .string()
        .min(1)
        .max(MAX_EXEC_CODE_LENGTH)
        .describe('Python source to run as a script; print() to return values'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(MAX_EXEC_TIMEOUT_MS)
        .optional()
        .describe('Wall-clock limit ms (default 30000, max 600000)'),
    })
    .strict()
);

export type RunPythonInput = z.infer<typeof RunPythonInputSchema>;

export const RunSkillScriptInputSchema = z
  .object({
    args: z.array(z.string().max(2000)).max(64).optional().describe('Literal argv'),
    cwd: StrictRootRelativePathSchema.describe('Root-relative working directory'),
    root: z.string().min(1).max(500).describe('Mounted root name or id'),
    runtime: z.enum(['bash', 'node', 'python3']).describe('Script interpreter'),
    scriptPath: StrictRootRelativePathSchema.refine(
      (value) => value.startsWith('scripts/') && value.split('/').length >= 2,
      'Must begin with scripts/'
    ).describe('Listed scripts/... path'),
    skillName: z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
      .describe('Enabled skill name'),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const totalArgChars = (input.args ?? []).reduce((total, value) => total + value.length, 0);
    if (totalArgChars > 16_000) {
      context.addIssue({
        code: 'custom',
        message: 'Combined arguments exceed the 16000-character cap',
        path: ['args'],
      });
    }
  });

export type RunSkillScriptInput = z.infer<typeof RunSkillScriptInputSchema>;

// ============================================================================
// Persistent Command Session Tool Schemas
// ============================================================================

const CommandSessionRootSchema = z
  .string()
  .min(1)
  .max(500)
  .optional()
  .describe('Open folder name or durable id; omit when only one folder is open');

const CommandSessionIdSchema = z
  .string()
  .min(1)
  .max(200)
  .describe('Opaque session id returned by start or list');

export const InspectCommandSessionsInputSchema = z
  .object({
    operation: z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('list'),
            offset: z
              .number()
              .int()
              .min(0)
              .max(10_000)
              .optional()
              .describe('Session offset from a previous truncated list page'),
          })
          .strict(),
        z
          .object({
            action: z.literal('read'),
            cursor: z
              .number()
              .int()
              .min(-1)
              .optional()
              .describe(
                'Absolute read cursor; omit for retained output or use -1 for the live tail'
              ),
            sessionId: CommandSessionIdSchema,
          })
          .strict(),
      ])
      .describe('Exactly one inspection operation and only its valid fields'),
    root: CommandSessionRootSchema,
  })
  .strict();

export type InspectCommandSessionsInput = z.infer<typeof InspectCommandSessionsInputSchema>;

export const ManageCommandSessionInputSchema = z
  .object({
    operation: z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('start'),
            cols: z.number().int().min(1).max(5000).optional(),
            command: z.string().min(1).max(10_000).describe('Shell command to start'),
            cwd: z
              .string()
              .max(4096)
              .optional()
              .describe('Absolute or workspace-relative directory inside the selected root'),
            rows: z.number().int().min(1).max(5000).optional(),
          })
          .strict(),
        z
          .object({
            action: z.literal('write'),
            data: z.string().min(1).max(100_000).describe('Text to write verbatim'),
            sessionId: CommandSessionIdSchema,
          })
          .strict(),
        z.object({ action: z.literal('stop'), sessionId: CommandSessionIdSchema }).strict(),
        z.object({ action: z.literal('remove'), sessionId: CommandSessionIdSchema }).strict(),
      ])
      .describe('Exactly one process-control operation and only its valid fields'),
    root: CommandSessionRootSchema,
  })
  .strict();

export type ManageCommandSessionInput = z.infer<typeof ManageCommandSessionInputSchema>;
