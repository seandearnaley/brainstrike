import { desktopAssistantServerLogger as logger } from './logger';
import {
  type LiveDecisionRecord,
  recordLiveDecision,
  type SwarmDiagnosticsDatabase,
} from './swarm-diagnostics-records';

export type LiveDecisionLog = (hostRunId: string, record: LiveDecisionRecord) => Promise<void>;

/**
 * The /assistant/decide endpoint's live decision log (swarm diagnostics,
 * migration 139). Resolves the database per call, like the run persistence
 * port. A decision for a run that has no row is logged and not stored
 * (ruling 5); a failed write is logged with its own code and never fails the
 * endpoint (ruling 4).
 */
export function createLiveDecisionLog(
  getDatabase: () => Promise<SwarmDiagnosticsDatabase>
): LiveDecisionLog {
  return async (hostRunId, record) => {
    try {
      if ((await recordLiveDecision(await getDatabase(), hostRunId, record)) === 'run-missing') {
        logger.warn('Live decision log has no host run', {
          code: 'live_decision_log_run_missing',
          hostRunId,
          outcome: record.outcome,
          toolCallId: record.toolCallId,
        });
      }
    } catch (error) {
      logger.error('Live decision log failed to persist', {
        code: 'live_decision_log_failed',
        error,
        hostRunId,
        toolCallId: record.toolCallId,
      });
    }
  };
}
