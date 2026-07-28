import {
  Badge,
  Button,
  CopyTextButton,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@brainstrike/ui';
import type { LogRecord } from '@brainstrike/utils/logger';
import { ListTree } from 'lucide-react';
import {
  getLogRecordCauseChain,
  getLogRecordCode,
  getLogRecordContext,
  getLogRecordFingerprint,
  getLogRecordSource,
  getLogRecordStack,
  serializeLogContextJson,
  serializeLogRecordJson,
} from './log-diagnostic-metadata';

interface LogRecordDetailDialogProps {
  record: LogRecord;
}

interface DetailValueProps {
  label: string;
  value: string | null | undefined;
}

function buildCauseRows(causeChain: ReturnType<typeof getLogRecordCauseChain>) {
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

export function LogRecordDetailDialog({ record }: LogRecordDetailDialogProps) {
  const causeChain = getLogRecordCauseChain(record);
  const causeRows = buildCauseRows(causeChain);
  const stack = getLogRecordStack(record);
  const context = getLogRecordContext(record);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          aria-label={`View details for ${record.message ?? 'log record'}`}
          className="h-7 gap-1.5 px-2 text-xs"
          size="sm"
          variant="ghost"
        >
          <ListTree aria-hidden="true" className="h-3.5 w-3.5" />
          Details
        </Button>
      </DialogTrigger>
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

export function LogRowActions({ record }: LogRecordDetailDialogProps) {
  const recordLabel = record.message ?? 'log record';
  return (
    <div className="flex items-center gap-1">
      <LogRecordDetailDialog record={record} />
      <CopyTextButton
        ariaLabel={`Copy ${recordLabel} as JSON`}
        label="Copy JSON"
        text={() => serializeLogRecordJson(record)}
      />
    </div>
  );
}
