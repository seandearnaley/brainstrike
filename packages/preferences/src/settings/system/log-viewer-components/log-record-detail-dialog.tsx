import {
  Badge,
  Button,
  CopyTextButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import type { LogRecord } from '@brainstrike/utils/logger';
import { ListTree } from 'lucide-react';
import {
  getLogRecordCauseChainDiagnostics,
  getLogRecordCode,
  getLogRecordContext,
  getLogRecordFingerprint,
  getLogRecordSource,
  getLogRecordStack,
  serializeLogContextJson,
  serializeLogRecordJson,
} from './log-diagnostic-metadata';

interface LogRecordDetailDialogProps {
  onClose: () => void;
  record: LogRecord | null;
}

interface LogRowActionsProps {
  onShowDetails: (record: LogRecord) => void;
  record: LogRecord;
}

interface DetailValueProps {
  label: string;
  value: string | null | undefined;
}

function buildCauseRows(
  causeChain: ReturnType<typeof getLogRecordCauseChainDiagnostics>['entries']
) {
  const occurrences = new Map<string, number>();
  return causeChain.map((cause) => {
    const signature = `${cause.name}:${cause.code ?? ''}:${cause.message}`;
    const occurrence = (occurrences.get(signature) ?? 0) + 1;
    occurrences.set(signature, occurrence);
    return { cause, key: `${signature}:${occurrence}` };
  });
}

function DetailValue({ label, value }: DetailValueProps) {
  return (
    <div className="min-w-0 rounded-md border border-border/50 bg-muted/20 p-2">
      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="mt-1 break-all font-mono text-xs">{value ?? '—'}</div>
    </div>
  );
}

export function LogRecordDetailDialog({ record, onClose }: LogRecordDetailDialogProps) {
  if (!record) {
    return null;
  }
  const causeDiagnostics = getLogRecordCauseChainDiagnostics(record);
  const causeChain = causeDiagnostics.entries;
  const causeRows = buildCauseRows(causeChain);
  const stack = getLogRecordStack(record);
  const context = getLogRecordContext(record);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Diagnostic details</DialogTitle>
          <DialogDescription>
            {new Date(record.timestamp).toLocaleString()} · {record.level}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <DetailValue label="Source" value={getLogRecordSource(record)} />
            <DetailValue label="Code" value={getLogRecordCode(record)} />
            <DetailValue label="Fingerprint" value={getLogRecordFingerprint(record)} />
            <DetailValue label="Scope" value={record.scope} />
          </div>

          <section className="space-y-2">
            <h4 className="font-semibold text-sm">Message</h4>
            <div className="rounded-md border border-border/50 bg-muted/20 p-3 text-sm">
              {record.message ?? '—'}
            </div>
          </section>

          <section className="space-y-2">
            <h4 className="font-semibold text-sm">Cause chain</h4>
            {causeChain.length === 0 ? (
              <div className="text-muted-foreground text-sm">No cause chain recorded.</div>
            ) : (
              <ol className="space-y-2">
                {causeRows.map(({ cause, key }, index) => (
                  <li className="rounded-md border border-border/50 bg-muted/20 p-3" key={key}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">Cause {index + 1}</Badge>
                      <span className="font-semibold text-sm">{cause.name}</span>
                      {cause.code ? <code className="text-xs">{cause.code}</code> : null}
                    </div>
                    <p className="mt-2 text-sm">{cause.message}</p>
                  </li>
                ))}
              </ol>
            )}
            {causeDiagnostics.malformedEntryCount > 0 ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-2 text-destructive text-sm">
                {causeDiagnostics.malformedEntryCount}{' '}
                {causeDiagnostics.malformedEntryCount === 1
                  ? 'malformed cause entry was'
                  : 'malformed cause entries were'}{' '}
                omitted.
              </div>
            ) : null}
          </section>

          {stack ? (
            <section className="space-y-2">
              <h4 className="font-semibold text-sm">Stack</h4>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-xs">
                {stack}
              </pre>
            </section>
          ) : null}

          <section className="space-y-2">
            <h4 className="font-semibold text-sm">Context</h4>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-xs">
              {serializeLogContextJson(context)}
            </pre>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LogRowActions({ record, onShowDetails }: LogRowActionsProps) {
  const recordLabel = record.message ?? 'log record';
  return (
    <div className="flex items-center gap-1">
      <Button
        aria-label={`View details for ${recordLabel}`}
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => onShowDetails(record)}
        size="sm"
        variant="ghost"
      >
        <ListTree aria-hidden="true" className="h-3.5 w-3.5" />
        Details
      </Button>
      <CopyTextButton
        ariaLabel={`Copy ${recordLabel} as JSON`}
        label="Copy JSON"
        text={() => serializeLogRecordJson(record)}
      />
    </div>
  );
}
