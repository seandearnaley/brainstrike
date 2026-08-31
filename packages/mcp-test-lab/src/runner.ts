import {
  MCP_EVIDENCE_SCHEMA_VERSION,
  type McpEvidenceBundle,
  verifyMcpEvidenceBundle,
} from './evidence.js';
import type { McpArtifactIntegrityDependencies } from './evidence-artifact-integrity.js';
import type {
  McpEvidenceBlocker,
  McpEvidenceCommand,
  McpEvidenceSchema,
  McpTestCounts,
} from './evidence-schema.js';
import {
  createMcpLabRunnerDeadline,
  type McpLabRunnerCase,
  McpLabRunnerDeadlineError,
  selectMcpLabRunnerCases,
} from './runner-manifest.js';
import { getMcpLabScenario } from './scenario.js';

export const MCP_LAB_RUNNER_PHASES = Object.freeze(['red', 'green', 'verification'] as const);
export type McpLabRunnerPhase = (typeof MCP_LAB_RUNNER_PHASES)[number];

export interface McpLabRunnerCaseObservation {
  readonly capabilities: readonly string[];
  readonly correlationIds: readonly string[];
  readonly exitStatus: number;
  readonly negotiation:
    | { readonly era: 'legacy'; readonly revision: '2025-11-25' }
    | { readonly era: 'modern'; readonly revision: '2026-07-28' };
  readonly tests: McpTestCounts;
}

export interface McpLabRunnerPhaseOwner {
  close(signal: AbortSignal): Promise<{ readonly details: string; readonly verified: true }>;
  run(signal: AbortSignal): Promise<McpLabRunnerCaseObservation>;
}

export interface McpLabRunnerDependencies {
  createPhaseOwner(runnerCase: McpLabRunnerCase, phase: McpLabRunnerPhase): McpLabRunnerPhaseOwner;
  now(): number;
}

export interface McpLabVerificationInput {
  readonly blockers: readonly McpEvidenceBlocker[];
  readonly command: string;
  readonly git: McpEvidenceSchema['git'];
  readonly selection: unknown;
  readonly ticket: string;
}

interface CompletedPhase {
  readonly cleanupDetails: string;
  readonly observation: McpLabRunnerCaseObservation;
  readonly phase: McpLabRunnerPhase;
}

function deadlinePromise<T>(
  promise: Promise<T>,
  waitMs: number,
  label: string,
  onTimeout?: (error: McpLabRunnerDeadlineError) => void,
  reportedTimeoutMs = waitMs
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new McpLabRunnerDeadlineError(label, reportedTimeoutMs);
      onTimeout?.(error);
      reject(error);
    }, waitMs);
  });
  return Promise.race([promise, timedOut]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

function phaseBudgets(timeoutMs: number): readonly [operationMs: number, cleanupMs: number] {
  const cleanupMs = Math.min(1000, Math.max(1, Math.floor(timeoutMs / 4)));
  return [Math.max(1, timeoutMs - cleanupMs), cleanupMs];
}

function expectedAbort(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
  );
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('MCP lab runner failed with a non-Error value');
}

function validateCleanup(value: Awaited<ReturnType<McpLabRunnerPhaseOwner['close']>>): string {
  if (value.verified !== true || typeof value.details !== 'string' || value.details.trim() === '') {
    throw new Error('MCP lab runner cleanup proof is invalid');
  }
  return value.details;
}

async function runPhase(
  runnerCase: McpLabRunnerCase,
  phase: McpLabRunnerPhase,
  timeoutMs: number,
  remainingRunMs: () => number,
  dependencies: McpLabRunnerDependencies
): Promise<CompletedPhase> {
  const owner = dependencies.createPhaseOwner(runnerCase, phase);
  const controller = new AbortController();
  const [operationTimeoutMs, cleanupReserveMs] = phaseBudgets(timeoutMs);
  const runPromise = Promise.resolve().then(() => owner.run(controller.signal));
  let timedOut = false;
  let observation: McpLabRunnerCaseObservation | undefined;
  let primaryError: Error | undefined;
  try {
    observation = await deadlinePromise(
      runPromise,
      operationTimeoutMs,
      `${runnerCase.id}/${phase}`,
      (error) => {
        timedOut = true;
        controller.abort(error);
      },
      timeoutMs
    );
  } catch (error) {
    primaryError = asError(error);
  }
  let cleanupDetails: string | undefined;
  let cleanupError: Error | undefined;
  try {
    const cleanupController = new AbortController();
    const cleanupTimeoutMs = Math.max(1, Math.ceil(Math.min(cleanupReserveMs, remainingRunMs())));
    cleanupDetails = validateCleanup(
      await deadlinePromise(
        Promise.resolve().then(async () => {
          const [closeResult, runResult] = await Promise.allSettled([
            owner.close(cleanupController.signal),
            timedOut ? runPromise : Promise.resolve(),
          ]);
          const failures: Error[] = [];
          if (closeResult.status === 'rejected') {
            failures.push(asError(closeResult.reason));
          }
          if (
            runResult.status === 'rejected' &&
            !expectedAbort(runResult.reason, controller.signal)
          ) {
            failures.push(asError(runResult.reason));
          }
          if (failures.length > 0) {
            throw failures.length === 1
              ? failures[0]
              : new AggregateError(failures, 'MCP lab runner cleanup and run settlement failed');
          }
          if (closeResult.status !== 'fulfilled') {
            throw new Error('MCP lab runner cleanup did not return a proof');
          }
          return closeResult.value;
        }),
        cleanupTimeoutMs,
        `${runnerCase.id}/${phase}/cleanup`,
        (error) => cleanupController.abort(error)
      )
    );
  } catch (error) {
    cleanupError = asError(error);
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `MCP lab runner phase ${runnerCase.id}/${phase} and its cleanup both failed`
    );
  }
  if (primaryError) {
    throw primaryError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (!observation || cleanupDetails === undefined) {
    throw new Error('MCP lab runner phase completed without an observation or cleanup proof');
  }
  return Object.freeze({ cleanupDetails, observation, phase });
}

function capabilitySetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function assertCanonicalObservation(
  runnerCase: McpLabRunnerCase,
  scenario: ReturnType<typeof getMcpLabScenario>,
  completed: readonly CompletedPhase[]
): McpLabRunnerCaseObservation {
  const first = completed[0]?.observation;
  if (!first) {
    throw new Error(`MCP lab runner case "${runnerCase.id}" produced no phase observations`);
  }
  for (const { observation } of completed) {
    if (
      observation.negotiation.era !== scenario.protocol.era ||
      observation.negotiation.revision !== scenario.protocol.version
    ) {
      throw new Error(
        `MCP lab runner case "${runnerCase.id}" expected ${scenario.protocol.era} ${scenario.protocol.version} negotiation`
      );
    }
    if (!capabilitySetsEqual(observation.capabilities, first.capabilities)) {
      throw new Error(`MCP lab runner case "${runnerCase.id}" changed capabilities between phases`);
    }
  }
  return first;
}

function evidenceCommand(
  command: string,
  proofId: string,
  completed: CompletedPhase
): McpEvidenceCommand {
  return Object.freeze({
    command,
    exitStatus: completed.observation.exitStatus,
    phase: completed.phase,
    proofId,
    tests: Object.freeze({ ...completed.observation.tests }),
  });
}

async function buildEvidence(
  runnerCase: McpLabRunnerCase,
  completed: readonly CompletedPhase[],
  input: McpLabVerificationInput,
  integrity: McpArtifactIntegrityDependencies
): Promise<McpEvidenceBundle> {
  const scenario = getMcpLabScenario(runnerCase.scenarioId);
  const first = assertCanonicalObservation(runnerCase, scenario, completed);
  const schema: McpEvidenceSchema = {
    artifacts: [],
    blockers: [...input.blockers],
    cleanup: {
      command: input.command,
      details: completed.map(({ cleanupDetails }) => cleanupDetails).join('; '),
      exitStatus: 0,
      verified: true,
    },
    commands: completed.map((entry) => evidenceCommand(input.command, runnerCase.id, entry)),
    correlationIds: completed.flatMap(({ observation }) => [...observation.correlationIds]),
    desktop: { reason: 'protocol-lab-only', required: false },
    git: { ...input.git },
    negotiation: {
      capabilities: [...first.capabilities],
      era: first.negotiation.era,
      revision: first.negotiation.revision,
    },
    scenarioId: runnerCase.scenarioId,
    schemaVersion: MCP_EVIDENCE_SCHEMA_VERSION,
    ticket: input.ticket,
    versions: {
      conformance: {
        package: scenario.reference.conformancePackage,
        version: scenario.reference.conformanceVersion,
      },
      fixture: { id: scenario.fixture, ...scenario.fixtureSource },
      sdk: {
        package: scenario.reference.clientPackage,
        version: scenario.reference.sdkVersion,
      },
      spec: scenario.protocol.version,
    },
  };
  return verifyMcpEvidenceBundle(schema, integrity);
}

export async function runMcpLabVerification(
  input: McpLabVerificationInput,
  dependencies: McpLabRunnerDependencies,
  integrity: McpArtifactIntegrityDependencies
): Promise<readonly McpEvidenceBundle[]> {
  const selection = selectMcpLabRunnerCases(input.selection);
  const runDeadline = createMcpLabRunnerDeadline(selection.runTimeoutMs, dependencies.now);
  const bundles: McpEvidenceBundle[] = [];
  for (const runnerCase of selection.cases) {
    const caseDeadline = createMcpLabRunnerDeadline(selection.caseTimeoutMs, dependencies.now);
    const remainingMs = () => Math.min(caseDeadline.remainingMs(), runDeadline.remainingMs());
    const completed: CompletedPhase[] = [];
    for (const phase of MCP_LAB_RUNNER_PHASES) {
      caseDeadline.assertActive(`${runnerCase.id}/${phase}`);
      runDeadline.assertActive(`${runnerCase.id}/${phase}`);
      const timeoutMs = Math.ceil(remainingMs());
      completed.push(await runPhase(runnerCase, phase, timeoutMs, remainingMs, dependencies));
    }
    caseDeadline.assertActive(`${runnerCase.id}/case/evidence`);
    runDeadline.assertActive(`${runnerCase.id}/evidence`);
    const bundle = await buildEvidence(runnerCase, completed, input, integrity);
    caseDeadline.assertActive(`${runnerCase.id}/case/evidence`);
    runDeadline.assertActive(`${runnerCase.id}/evidence`);
    bundles.push(bundle);
  }
  return Object.freeze(bundles);
}
