import { Button } from '@brainstrike/ui';
import { AlertCircle } from 'lucide-react';
import type { ReactElement } from 'react';
import type { PreviewContentFailure } from './preview-content-failure';

function describeContextExportFailure(
  failure: Extract<PreviewContentFailure, { kind: 'context-export' }>
): {
  readonly buttonLabel: string | null;
  readonly description: string;
  readonly title: string;
} {
  const title = failure.action === 'copy' ? 'Context copy failed' : 'Context download failed';
  if (failure.outcome.reason === 'root-unavailable') {
    return {
      buttonLabel: null,
      description: 'Choose a workspace folder before exporting context.',
      title,
    };
  }
  if (failure.outcome.reason === 'generation-failed') {
    return {
      buttonLabel: failure.action === 'copy' ? 'Retry context copy' : 'Retry context download',
      description: 'The selected context could not be prepared.',
      title,
    };
  }
  return {
    buttonLabel: failure.action === 'copy' ? 'Retry context copy' : 'Retry context download',
    description:
      failure.action === 'copy'
        ? 'The generated context could not be copied to the clipboard.'
        : 'The generated context could not be saved.',
    title,
  };
}

export function PreviewContentFailureAlert({
  failure,
  onRetry,
}: {
  readonly failure: PreviewContentFailure;
  readonly onRetry: () => void;
}): ReactElement {
  const content =
    failure.kind === 'preview-load'
      ? {
          buttonLabel: 'Retry preview content',
          description:
            failure.compositeKeys.length === 1
              ? '1 selected file could not be loaded.'
              : `${failure.compositeKeys.length} selected files could not be loaded.`,
          title: 'Preview content unavailable',
        }
      : describeContextExportFailure(failure);
  const titleId =
    failure.kind === 'preview-load' ? 'preview-content-error-title' : 'context-export-error-title';

  return (
    <div
      aria-labelledby={titleId}
      className="m-3 flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3"
      role="alert"
    >
      <AlertCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm" id={titleId}>
          {content.title}
        </p>
        <p className="text-muted-foreground text-xs">{content.description}</p>
      </div>
      {content.buttonLabel ? (
        <Button onClick={onRetry} size="sm" type="button" variant="outline">
          {content.buttonLabel}
        </Button>
      ) : null}
    </div>
  );
}
