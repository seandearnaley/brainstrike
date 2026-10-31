/**
 * Logger interface shared by tool wrappers.
 */
export interface ToolLogger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}
