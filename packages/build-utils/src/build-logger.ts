interface BuildLogger {
  debug: (message: string, metadata?: Record<string, unknown>) => void;
  warn: (message: string, metadata?: Record<string, unknown>) => void;
}

function formatMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) {
    return '';
  }
  return ` ${JSON.stringify(metadata)}`;
}

export function createBuildLogger(scope: string): BuildLogger {
  return {
    debug(message, metadata) {
      process.stdout.write(`[${scope}] DEBUG ${message}${formatMetadata(metadata)}\n`);
    },
    warn(message, metadata) {
      process.stderr.write(`[${scope}] WARN ${message}${formatMetadata(metadata)}\n`);
    },
  };
}
