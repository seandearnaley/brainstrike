import {
  describeBoundaryError,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import { callBoundary } from '@brainstrike/assistant-contract/boundary-result';
import { LogBuffer, LogLevel, type LogRecord } from '@brainstrike/logging';
import type { LogSourceAdapter } from '@brainstrike/settings-ui/settings/system/logging-settings-section';
import { getRendererLogBuffer } from './log-buffer';

/** This renderer's buffer joined with Electron main's, which streams its durable records. */
export function createDesktopLogSource(): LogSourceAdapter {
  const buffer = getRendererLogBuffer();
  const mainBuffer = new LogBuffer();
  let diagnostic: LogRecord | undefined;
  const subscribers = new Set<(records: readonly LogRecord[]) => void>();
  const readRecords = () => [
    ...buffer.getRecords(),
    ...mainBuffer.getRecords(),
    ...(diagnostic ? [diagnostic] : []),
  ];
  const publish = () => {
    const records = readRecords();
    for (const handler of subscribers) {
      handler(records);
    }
  };
  return {
    getInitialRecords: async () => {
      try {
        const getMainRecords = window.logging?.getBufferedLogs;
        if (!getMainRecords) {
          throw refusalError(
            'availability',
            'logging.unavailable',
            'Electron main logging is unavailable.'
          );
        }
        const records = await callBoundary(getMainRecords);
        mainBuffer.clear();
        for (const record of records) {
          mainBuffer.push(record);
        }
        diagnostic = undefined;
      } catch (error) {
        diagnostic = createMainLogSourceDiagnostic(describeBoundaryError(error));
      }
      publish();
      return readRecords();
    },
    subscribe: (handler) => {
      subscribers.add(handler);
      const unsubscribeRenderer = buffer.subscribe(publish);
      const unsubscribeMain = window.logging?.onDurableRecord((record) => {
        mainBuffer.push(record);
        publish();
      });
      return () => {
        subscribers.delete(handler);
        unsubscribeRenderer();
        unsubscribeMain?.();
      };
    },
  };
}

function createMainLogSourceDiagnostic(reason: string): LogRecord {
  return {
    args: [{ reason }],
    bindings: {
      logSource: 'electron-main',
      runtime: 'electron-renderer',
    },
    level: LogLevel.WARN,
    message: 'Electron main logs unavailable',
    scope: 'DesktopLoggingSettings',
    timestamp: Date.now(),
  };
}
