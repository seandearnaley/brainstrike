import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { HostRecord } from './record.js';

const HOST_PHASES = [
  'monitor-start',
  'loop-delay',
  'attach-settled',
  'attach-succeeded',
  'attach-timeout',
  'socket-connect',
  'socket-connected',
  'initialize-send',
  'initialize-reply',
  'record-matched',
  'record-publication-timeout',
  'record-publication-settled',
  'record-discovery-owner',
  'record-discovery-timeout',
  'record-discovery-settled',
  'host-close-start',
  'host-record-created',
  'host-socket-accepted',
  'host-record-publish-start',
  'host-record-published',
  'host-runtime-monitor-stopped',
  'host-initialize-received',
  'host-initialize-reply-ready',
  'relay-profile-acquired',
  'relay-opened',
  'reader-record-candidates',
  'reader-selected-record',
  'utility-exit',
  'utility-close-request',
  'utility-close-joined',
  'utility-lifetime-port-close',
  'utility-close-timeout',
  'utility-spawned',
  'utility-ready',
] as const;
type HostPhase = (typeof HOST_PHASES)[number];
const hostPhases = new Set<string>(HOST_PHASES);
const HOST_SCOPES = [
  'agent-socket',
  'record-publication',
  'record-discovery',
  'host-runtime',
] as const;
type HostScope = (typeof HOST_SCOPES)[number];
const hostScopes = new Set<string>(HOST_SCOPES);
const PUBLICATION_STAGES = [
  'liveLease-before',
  'liveLease-after',
  'readHostRecord-before',
  'readHostRecord-after',
  'existingRecord-before',
  'existingRecord-after',
] as const;
type PublicationStage = (typeof PUBLICATION_STAGES)[number];
const publicationStages = new Set<string>(PUBLICATION_STAGES);
const publicationOutcomes = new Set<string>(['missing', 'matched', 'mismatched']);
type PublicationOutcome = 'missing' | 'matched' | 'mismatched';
const PATH_ID = /^[0-9a-f]{24}$/u;

type Identity = Pick<HostRecord, 'pid' | 'start'> & Partial<Pick<HostRecord, 'endpoint'>>;
export interface HostAttachmentDiagnosticFields {
  readonly budget?: 'raw-client' | 'existing-owner' | 'race-winner' | 'self-started' | undefined;
  readonly candidateCount?: number | undefined;
  readonly candidatePathIds?: readonly string[] | undefined;
  readonly childPid?: number | undefined;
  readonly closeRequested?: boolean | undefined;
  readonly exitCode?: number | undefined;
  readonly remainingMs?: number | undefined;
  readonly selectedPathId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}
export interface HostAttachmentDiagnostics {
  finish(phase: HostPhase): void;
  phase(phase: HostPhase, record?: Identity): void;
  publicationStage(stage: PublicationStage, outcome?: PublicationOutcome): void;
}
const RESOLUTION_MS = 20;
let sequence = 0;
let emitted = 0;
const MAX_EVENTS = 512;
function admitEvent(): boolean {
  if (process.env['BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE'] !== '1' || emitted > MAX_EVENTS) {
    return false;
  }
  if (emitted++ === MAX_EVENTS) {
    process.stderr.write(
      '[host-attach-proof] ' +
        JSON.stringify({
          limit: MAX_EVENTS,
          phase: 'truncated',
          processPid: process.pid,
          timeOrigin: performance.timeOrigin,
        }) +
        '\n'
    );
    return false;
  }
  return true;
}

/** Only discovery paths and OS start identities; never a credential or payload. */
export function hostAttachmentDiagnosticId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/** PROOF ONLY. Whitelist fields rather than serializing a lease record. */
export function writeHostAttachmentDiagnostic(
  phase: HostPhase,
  record?: Identity,
  fields: HostAttachmentDiagnosticFields = {}
): void {
  if (process.env['BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE'] !== '1') {
    return;
  }
  if (!(hostPhases.has(phase) && admitEvent())) {
    return;
  }
  const candidates =
    fields.candidatePathIds?.filter((id) => typeof id === 'string' && PATH_ID.test(id)) ?? [];
  process.stderr.write(
    '[host-attach-proof] ' +
      JSON.stringify({
        at: Date.now(),
        budget: fields.budget,
        candidateCount: fields.candidateCount,
        candidatePathIds: fields.candidatePathIds ? candidates.slice(0, 16) : undefined,
        candidatePathIdsTruncated:
          candidates.length > 16 ||
          (fields.candidateCount !== undefined && fields.candidateCount > 16),
        childPid: fields.childPid,
        closeRequested: fields.closeRequested,
        endpointId: record?.endpoint ? hostAttachmentDiagnosticId(record.endpoint) : undefined,
        exitCode: fields.exitCode,
        hostPid: record?.pid,
        hostStartId: record ? hostAttachmentDiagnosticId(record.start) : undefined,
        monotonicMs: performance.now(),
        phase,
        processPid: process.pid,
        selectedPathId:
          fields.selectedPathId && PATH_ID.test(fields.selectedPathId)
            ? fields.selectedPathId
            : undefined,
        sequence: ++sequence,
        timeOrigin: performance.timeOrigin,
        timeoutMs: fields.timeoutMs,
      }) +
      '\n'
  );
}

/** Same perf_hooks primitive and resolution subtraction as the foreground probes. */
export function startHostAttachmentDiagnostics(
  scope: HostScope,
  record?: Identity,
  fields: HostAttachmentDiagnosticFields = {}
): HostAttachmentDiagnostics | undefined {
  if (process.env['BRAINSTRIKE_E2E_WORKSPACE_PHASE_TRACE'] !== '1') {
    return;
  }
  if (!hostScopes.has(scope)) {
    return;
  }
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  const started = performance.now();
  const cpu = process.cpuUsage();
  const utilization = performance.eventLoopUtilization();
  const attemptId = `${process.pid}:${++sequence}`;
  let identity = record;
  let finished = false;
  let peakLagMs = 0;
  let timerLagMs = 0;
  let lastStage: PublicationStage | undefined;
  let lastOutcome: PublicationOutcome | undefined;
  let stageStarted: number | undefined;
  let due = started + 1000;
  const phase = (name: HostPhase, current?: Identity): void => {
    identity = current ?? identity;
    if (!(hostPhases.has(name) && admitEvent())) {
      return;
    }
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const loop = performance.eventLoopUtilization(utilization);
    peakLagMs = Math.max(peakLagMs, Math.max(0, histogram.max / 1e6 - RESOLUTION_MS));
    process.stderr.write(
      '[host-attach-proof] ' +
        JSON.stringify({
          at: Date.now(),
          attemptId,
          budget: fields.budget,
          budgetOvershootMs:
            name.endsWith('timeout') && fields.timeoutMs !== undefined
              ? Math.max(0, elapsedMs - fields.timeoutMs)
              : undefined,
          cpuSystemMs: used.system / 1000,
          cpuUserMs: used.user / 1000,
          elapsedMs,
          endpointId: identity?.endpoint
            ? hostAttachmentDiagnosticId(identity.endpoint)
            : undefined,
          eventLoopLagMaxMs: peakLagMs,
          eventLoopSamples: histogram.count,
          eventLoopUtilization: loop.utilization,
          hostPid: identity?.pid,
          hostStartId: identity ? hostAttachmentDiagnosticId(identity.start) : undefined,
          lastOutcome,
          lastStage,
          monotonicMs: performance.now(),
          phase: name,
          processPid: process.pid,
          remainingMs: fields.remainingMs,
          scope,
          sequence: ++sequence,
          stageElapsedMs: stageStarted === undefined ? undefined : performance.now() - stageStarted,
          timeOrigin: performance.timeOrigin,
          timeoutMs: fields.timeoutMs,
          timerLagMs,
        }) +
        '\n'
    );
  };
  const timer = setInterval(() => {
    const now = performance.now();
    const currentLag = now - due;
    timerLagMs = Math.max(timerLagMs, currentLag);
    due = now + 1000;
    if (currentLag >= 100 || histogram.max / 1e6 - RESOLUTION_MS >= 100) {
      phase('loop-delay');
      histogram.reset();
    }
  }, 1000);
  timer.unref();
  phase('monitor-start');
  return {
    finish(name) {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(timer);
      histogram.disable();
      phase(name);
    },
    phase,
    publicationStage(stage, outcome) {
      if (
        (scope !== 'record-publication' && scope !== 'record-discovery') ||
        !publicationStages.has(stage)
      ) {
        return;
      }
      lastStage = stage;
      lastOutcome = outcome && publicationOutcomes.has(outcome) ? outcome : undefined;
      stageStarted = performance.now();
    },
  };
}
