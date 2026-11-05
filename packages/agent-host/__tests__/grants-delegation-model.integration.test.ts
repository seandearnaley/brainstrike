/**
 * ADR-0010 and ADR-0031 as a model-based test: generated sequences of policy
 * changes, root calls and delegated child calls run against a real HostCore,
 * and every call's fate must match a small reference model of the policy,
 * the thread's grants and each child's admitted snapshot.
 *
 * - A deny (the tool's own, or its category's) beats every grant and Full.
 * - A grant is recorded before the pending call resumes, so the same leg sees it.
 * - A child keeps only its admitted denies; every other decision follows the
 *   live root policy and the root's grants, including those made after admission.
 * - A read-only child is never offered a delegation tool.
 *
 * Children here are one level deep and each is admitted fresh, so a tool its
 * admitted snapshot denies is simply never offered to it. A frozen deny that
 * outlives a live change would show only in a grandchild, which this does not
 * generate yet.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PERMISSION_POLICIES,
  type PermissionDecision,
  type PermissionToolGateSnapshot,
} from '@brainstrike/assistant-contract';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { getAdjustedTimeout } from '@brainstrike/test-utils/test-timeouts';
import { MockLanguageModelV4 } from 'ai/test';
import fc from 'fast-check';
import { afterEach, expect, test } from 'vitest';
import type { HostEvent, HostLogRow, HostPermissionGrant } from '../src/protocol.ts';
import {
  type CallOptions,
  type ChildRunHarness,
  setupChildRunHost,
  stream,
  text,
  toolCall,
  toolNames,
  userTexts,
  worker,
} from './fixtures/child-run-host.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) {
    await close();
  }
});

/** The fixture host's gated tools and their risk categories. */
const TOOLS = {
  read_file: { input: { path: 'notes.md' }, risk: 'read' },
  run_command: { input: { command: 'true' }, risk: 'execute' },
  write_file: { input: { path: 'notes.md' }, risk: 'edit' },
} as const;
type Tool = keyof typeof TOOLS;
type Risk = (typeof TOOLS)[Tool]['risk'];
const TOOL_IDS = Object.keys(TOOLS) as Tool[];
const RISKS = ['read', 'edit', 'execute'] as const satisfies readonly Risk[];

const scout: AssistantPersonaDefinition = {
  allowedToolIds: ['read_file', 'write_file'],
  description: 'Looks around without changing anything.',
  id: 'scout',
  instructions: 'You are the Scout subagent.',
  label: 'Scout',
  maxSteps: 4,
  mode: 'read-only',
};

// ── The reference model ───────────────────────────────────────────────────────

interface Policy {
  readonly overrides: Partial<Record<Tool, PermissionDecision>>;
  readonly policies: Record<Risk, PermissionDecision>;
  readonly yolo: boolean;
}
interface Grants {
  readonly categories: Set<Risk>;
  readonly tools: Set<Tool>;
}

function denies(policy: Policy, tool: Tool): boolean {
  return policy.overrides[tool] === 'deny' || policy.policies[TOOLS[tool].risk] === 'deny';
}

/**
 * The documented decision: any deny wins (the live one, or the child's
 * admitted one); then Full; then a tool grant; then the tool's own setting;
 * then a category grant; then the category's setting.
 */
function expected(
  live: Policy,
  grants: Grants,
  tool: Tool,
  admitted?: Policy
): 'allow' | 'ask' | 'deny' {
  if (denies(live, tool) || (admitted && denies(admitted, tool))) {
    return 'deny';
  }
  if (live.yolo || grants.tools.has(tool)) {
    return 'allow';
  }
  const override = live.overrides[tool];
  if (override) {
    return override;
  }
  return grants.categories.has(TOOLS[tool].risk) ? 'allow' : live.policies[TOOLS[tool].risk];
}

function snapshot(policy: Policy): PermissionToolGateSnapshot {
  return {
    perToolOverrides: { ...policy.overrides },
    policies: { ...DEFAULT_PERMISSION_POLICIES, ...policy.policies },
    yolo: policy.yolo,
  };
}

// ── Generated steps ───────────────────────────────────────────────────────────

type Change =
  | { readonly kind: 'category'; readonly risk: Risk; readonly decision: PermissionDecision }
  | { readonly kind: 'override'; readonly tool: Tool; readonly decision?: PermissionDecision }
  | { readonly kind: 'yolo'; readonly on: boolean };
type Answer =
  | { readonly decision: 'deny' }
  | { readonly decision: 'approve'; readonly grant?: 'session' | 'tool' };
interface Call {
  readonly answer: Answer;
  readonly tool: Tool;
}
type Step =
  | { readonly kind: 'change'; readonly change: Change }
  | {
      readonly kind: 'turn';
      /** Who makes the calls: the root run, or a child it delegates to and awaits. */
      readonly actor: 'root' | 'worker' | 'scout';
      readonly calls: readonly Call[];
      /** Changes made after the caller is admitted, before its first call. */
      readonly midway: readonly Change[];
    };

// Weighted toward asking, where grants and answers decide what happens.
const decisionArb = fc.constantFrom<PermissionDecision>('allow', 'ask', 'ask', 'deny');
const toolArb = fc.constantFrom(...TOOL_IDS);
const changeArb: fc.Arbitrary<Change> = fc.oneof(
  fc.record({
    decision: decisionArb,
    kind: fc.constant('category' as const),
    risk: fc.constantFrom(...RISKS),
  }),
  fc.record(
    {
      decision: decisionArb,
      kind: fc.constant('override' as const),
      tool: toolArb,
    },
    { requiredKeys: ['kind', 'tool'] }
  ),
  fc.record({ kind: fc.constant('yolo' as const), on: fc.boolean() })
);
const answerArb: fc.Arbitrary<Answer> = fc.oneof(
  { arbitrary: fc.constant({ decision: 'deny' as const }), weight: 1 },
  { arbitrary: fc.constant({ decision: 'approve' as const }), weight: 1 },
  {
    arbitrary: fc.record({
      decision: fc.constant('approve' as const),
      grant: fc.constantFrom('session' as const, 'tool' as const),
    }),
    weight: 2,
  }
);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { arbitrary: fc.record({ change: changeArb, kind: fc.constant('change' as const) }), weight: 2 },
  {
    arbitrary: fc.record({
      actor: fc.constantFrom('root' as const, 'worker' as const, 'scout' as const),
      calls: fc.array(fc.record({ answer: answerArb, tool: toolArb }), {
        maxLength: 3,
        minLength: 1,
      }),
      kind: fc.constant('turn' as const),
      midway: fc.array(changeArb, { maxLength: 2 }),
    }),
    weight: 3,
  }
);
const initialArb = fc.record({
  overrides: fc.dictionary(toolArb, decisionArb, { maxKeys: 2 }),
  policies: fc.record({ edit: decisionArb, execute: decisionArb, read: decisionArb }),
  yolo: fc.constantFrom(false, false, false, true),
});

function applyChange(policy: Policy, change: Change): Policy {
  switch (change.kind) {
    case 'category':
      return { ...policy, policies: { ...policy.policies, [change.risk]: change.decision } };
    case 'override': {
      const { [change.tool]: _removed, ...rest } = policy.overrides;
      return {
        ...policy,
        overrides: change.decision ? { ...rest, [change.tool]: change.decision } : rest,
      };
    }
    case 'yolo':
      return { ...policy, yolo: change.on };
    default:
      return policy;
  }
}

/**
 * BST-2460: the host's policy snapshot names no tool risks, so a child's
 * ceiling resolves a tool with a per-tool setting under `mcp`. Removing that
 * setting while the child runs leaves the child on `mcp`'s decision instead of
 * the tool's category. Until the fix, children see no midway removal; the
 * pinned case below keeps the bug visible.
 */
function reachesChildrenAsDocumented(change: Change): boolean {
  return !(change.kind === 'override' && change.decision === undefined);
}

// ── Driving the real host ─────────────────────────────────────────────────────

interface Gate {
  reach(): void;
  readonly reached: Promise<void>;
  release(): void;
  readonly released: Promise<void>;
}
function gate(): Gate {
  let reach: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reach, reached, release, released };
}

interface TurnScript {
  readonly actor: 'root' | 'worker' | 'scout';
  readonly calls: readonly Call[];
  readonly gate: Gate;
  /** The fixture tools the caller was offered on its first step. */
  offered?: string[];
}

/** Tool calls the provider asked for after the latest user message. */
function stepsTaken(call: CallOptions): number {
  const lastUser = call.prompt.findLastIndex((message) => message.role === 'user');
  return call.prompt.slice(lastUser + 1).filter((message) => message.role === 'tool').length;
}

function scriptedModel(turns: Map<number, TurnScript>): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (call) => {
      const last = userTexts(call).at(-1) ?? '';
      const child = /CHILD_TASK (\d+)/u.exec(last);
      const root = /ROOT_TURN (\d+)/u.exec(last);
      const turn = turns.get(Number(child?.[1] ?? root?.[1]));
      if (!turn) {
        return stream(text('No scripted turn.'));
      }
      const index = Number(child?.[1] ?? root?.[1]);
      const steps = stepsTaken(call);
      if (!child && turn.actor !== 'root') {
        return stream(
          steps === 0
            ? toolCall(
                `agent-${turn.actor}`,
                {
                  _background: { disposition: 'awaited', enabled: true },
                  prompt: `CHILD_TASK ${index}`,
                },
                `delegate-${index}`
              )
            : text('Root continues.')
        );
      }
      const next = turn.calls[steps];
      if (!next) {
        return stream(text('Done.'));
      }
      if (steps === 0) {
        turn.offered = toolNames(call);
        turn.gate.reach();
        await turn.gate.released;
      }
      return stream(toolCall(next.tool, TOOLS[next.tool].input, `call-${index}-${steps}`));
    },
  });
}

/** Every committed row, as the host publishes it, and a wait for the next one. */
function watch(harness: ChildRunHarness) {
  const rows: HostLogRow[] = [];
  let wake: () => void = () => undefined;
  harness.core().onCommitted((row) => {
    rows.push(row);
    wake();
  });
  return {
    next: () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    rows,
  };
}

type Requested = Extract<HostEvent, { type: 'interaction.requested' }>;

/** Runs `steps` on a fresh host and checks every call against the model. */
async function checkAgainstModel(
  initial: Policy,
  steps: readonly Step[],
  midwayForChildren: (change: Change) => boolean
): Promise<void> {
  const turns = new Map<number, TurnScript>();
  let live: Policy = initial;
  const grants: Grants = { categories: new Set(), tools: new Set() };
  const harness = await setupChildRunHost(scriptedModel(turns), cleanup, {
    personas: [worker, scout],
    policy: () => snapshot(live),
  });
  const log = watch(harness);
  try {
    for (const [index, step] of steps.entries()) {
      if (step.kind === 'change') {
        live = applyChange(live, step.change);
        continue;
      }
      const turn: TurnScript = { actor: step.actor, calls: step.calls, gate: gate() };
      turns.set(index, turn);
      // A worker child is admitted under the live policy of its delegation.
      const admitted = step.actor === 'root' ? undefined : live;
      const atAdmission = live;
      const runId = (
        await harness.core().startRun({
          commandId: randomUUID(),
          modelId: 'scripted',
          prompt: `ROOT_TURN ${index}`,
          threadId: harness.threadId,
        })
      ).runId;
      const finishedFirst = await Promise.race([
        turn.gate.reached.then(() => false),
        (async () => {
          while (
            !log.rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId)
          ) {
            await log.next();
          }
          return true;
        })(),
      ]);
      // Delegation tools are read-risk, so a read deny withholds them: no child, no call.
      const delegable = step.actor === 'root' || atAdmission.policies.read !== 'deny';
      expect(finishedFirst).toBe(!delegable);
      if (!delegable) {
        expect(
          log.rows.filter(
            (row) =>
              'toolCallId' in row.event &&
              row.event.toolCallId?.startsWith(`call-${index}-`) === true
          )
        ).toEqual([]);
        continue;
      }

      // Denied tools are never offered; a read-only child is offered only read tools and no delegation.
      const offered = (turn.offered ?? []).filter((name) => name in TOOLS);
      expect(offered).toEqual(
        TOOL_IDS.filter(
          (tool) =>
            !denies(atAdmission, tool) &&
            (step.actor !== 'scout' ||
              (TOOLS[tool].risk === 'read' && scout.allowedToolIds.includes(tool)))
        ).sort()
      );
      if (step.actor === 'scout') {
        expect((turn.offered ?? []).filter((name) => name.startsWith('agent-'))).toEqual([]);
      }
      for (const change of step.actor === 'root'
        ? step.midway
        : step.midway.filter(midwayForChildren)) {
        live = applyChange(live, change);
      }
      turn.gate.release();

      // Each call's fate, decided in order: an approval's grant is in force for the next call.
      const fates: { asked: boolean; ran: boolean }[] = [];
      for (const call of step.calls) {
        const decision = offered.includes(call.tool)
          ? expected(live, grants, call.tool, admitted)
          : 'deny';
        if (decision !== 'ask') {
          fates.push({ asked: false, ran: decision === 'allow' });
          continue;
        }
        fates.push({ asked: true, ran: call.answer.decision === 'approve' });
        if (call.answer.decision === 'approve' && call.answer.grant === 'session') {
          grants.categories.add(TOOLS[call.tool].risk);
        }
        if (call.answer.decision === 'approve' && call.answer.grant === 'tool') {
          grants.tools.add(call.tool);
        }
      }

      // Answer each approval as it arrives, until the root run finishes.
      const answered = new Set<string>();
      const deadline = Date.now() + getAdjustedTimeout('integration');
      for (;;) {
        if (
          log.rows.some((row) => row.event.type === 'run.finished' && row.event.runId === runId)
        ) {
          break;
        }
        const pending = log.rows
          .map((row) => ({ event: row.event, threadId: row.threadId }))
          .find(
            (row): row is { event: Requested; threadId: string } =>
              row.event.type === 'interaction.requested' &&
              row.event.toolCallId.startsWith(`call-${index}-`) &&
              !answered.has(row.event.interactionId)
          );
        if (pending) {
          answered.add(pending.event.interactionId);
          const at = Number(pending.event.toolCallId.split('-').at(-1));
          const call = step.calls[at];
          if (!call) {
            throw new Error(`Unexpected approval for ${pending.event.toolCallId}`);
          }
          const grant: HostPermissionGrant | undefined =
            call.answer.decision === 'approve' && call.answer.grant === 'session'
              ? { category: TOOLS[call.tool].risk, scope: 'session' }
              : call.answer.decision === 'approve' && call.answer.grant === 'tool'
                ? { scope: 'tool', toolId: call.tool }
                : undefined;
          await harness.core().respond({
            commandId: randomUUID(),
            decision: call.answer.decision,
            ...(grant ? { grant } : {}),
            interactionId: pending.event.interactionId,
            runId: pending.event.runId,
            threadId: pending.threadId,
          });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Turn ${index} did not finish`);
        }
        await log.next();
      }

      const observed = step.calls.map((_call, at) => {
        const id = `call-${index}-${at}`;
        return {
          asked: log.rows.some(
            (row) => row.event.type === 'interaction.requested' && row.event.toolCallId === id
          ),
          ran: log.rows.some(
            (row) => row.event.type === 'effect.started' && row.event.toolCallId === id
          ),
        };
      });
      expect(observed).toEqual(fates);
    }
  } finally {
    for (const close of cleanup.splice(0).reverse()) {
      await close();
    }
  }
}

test('every call is ran, asked or refused exactly as the policy, grants and admitted denies say', async () => {
  await fc.assert(
    fc.asyncProperty(
      initialArb,
      fc.array(stepArb, { maxLength: 6, minLength: 1 }),
      (initial, steps) => checkAgainstModel(initial, steps, reachesChildrenAsDocumented)
    ),
    { numRuns: 100 }
  );
}, 300_000);

test.fails('a per-tool Allow removed while a child runs no longer lets the child skip asking (BST-2460)', async () => {
  await checkAgainstModel(
    {
      overrides: { read_file: 'allow' },
      policies: { edit: 'ask', execute: 'ask', read: 'ask' },
      yolo: false,
    },
    [
      {
        actor: 'worker',
        calls: [{ answer: { decision: 'deny' }, tool: 'read_file' }],
        kind: 'turn',
        midway: [{ kind: 'override', tool: 'read_file' }],
      },
    ],
    () => true
  );
});
