/**
 * MCP elicitation consent dialog (BST-1584).
 *
 * Renders one `McpElicitationPresentationWire` pushed from desktop main. The
 * dialog is deliberately non-dismissible: every exit is an explicit `accept`,
 * `decline`, or `cancel` settlement carrying the presentation's provenance
 * (server id, generation, request id), or — once main reports the request
 * retired — a local "Dismiss". Provenance (server identity, website origin,
 * operation, negotiated revision) is part of the accessible description so the
 * user always knows WHO is asking and DURING WHAT.
 *
 * URL mode shows the full URL verbatim and never opens it here: the browser is
 * opened by desktop main only after an explicit `accept` (one-use grant).
 * Decline is the default-focused action in both modes.
 */
import type {
  McpElicitationPresentationWire,
  McpElicitationPrimitiveSchemaWire,
  McpElicitationProvenanceWire,
  McpElicitationSettlement,
} from '@brainstrike/assistant-contract';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@brainstrike/ui';
import type React from 'react';
import { type FormEvent, useCallback, useId, useRef, useState } from 'react';
import {
  buildMcpElicitationContent,
  describeMcpElicitationField,
  initialMcpElicitationFieldValues,
  type McpElicitationFieldValue,
  type McpElicitationFieldValues,
  readMcpElicitationFieldOptions,
} from './mcp-elicitation-form';

export interface McpElicitationDialogProps {
  readonly onDismissRetired: () => void;
  readonly onSettle: (settlement: McpElicitationSettlement) => Promise<void>;
  readonly presentation: McpElicitationPresentationWire;
  readonly retiredCode?: string | undefined;
}

function serverLabel(provenance: McpElicitationProvenanceWire): string {
  return (
    provenance.serverIdentity?.title ??
    provenance.serverIdentity?.name ??
    provenance.configuredServerId
  );
}

function describeProvenance(provenance: McpElicitationProvenanceWire): string {
  const identity = provenance.serverIdentity;
  const identityText = identity
    ? `${identity.name} ${identity.version}${identity.websiteOrigin ? ` (${identity.websiteOrigin})` : ''}`
    : 'no server identity';
  const operationText = provenance.operation.target
    ? `${provenance.operation.type} ${provenance.operation.target}`
    : provenance.operation.type;
  return `Configured server "${provenance.configuredServerId}" — ${identityText} — asked during ${operationText} over ${provenance.transport}, MCP revision ${provenance.negotiatedRevision}.`;
}

function settlementBase(
  presentation: McpElicitationPresentationWire
): Pick<McpElicitationSettlement, 'configuredServerId' | 'generation' | 'id' | 'requestId'> {
  return {
    configuredServerId: presentation.provenance.configuredServerId,
    generation: presentation.provenance.generation,
    id: presentation.id,
    requestId: presentation.provenance.requestId,
  };
}

function inputTypeFor(schema: McpElicitationPrimitiveSchemaWire): string {
  if (schema.type === 'number' || schema.type === 'integer') {
    return 'number';
  }
  if (schema.type === 'string' && !('enum' in schema || 'oneOf' in schema)) {
    switch (schema.format) {
      case 'email':
        return 'email';
      case 'uri':
        return 'url';
      case 'date':
        return 'date';
      default:
        return 'text';
    }
  }
  return 'text';
}

interface FieldProps {
  readonly disabled: boolean;
  readonly error: string | undefined;
  readonly idPrefix: string;
  readonly name: string;
  readonly onChange: (value: McpElicitationFieldValue) => void;
  readonly required: boolean;
  readonly schema: McpElicitationPrimitiveSchemaWire;
  readonly value: McpElicitationFieldValue;
}

interface FieldChrome {
  readonly aria: {
    readonly 'aria-describedby': string | undefined;
    readonly 'aria-invalid': true | undefined;
    readonly 'aria-required': true | undefined;
  };
  readonly controlId: string;
  readonly description: React.ReactNode;
  readonly errorText: React.ReactNode;
  readonly label: React.ReactNode;
}

function useFieldChrome({
  error,
  idPrefix,
  name,
  required,
  schema,
}: Pick<FieldProps, 'error' | 'idPrefix' | 'name' | 'required' | 'schema'>): FieldChrome {
  const controlId = `${idPrefix}-${name}`;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const describedBy =
    [schema.description ? descriptionId : undefined, error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;
  return {
    aria: {
      'aria-describedby': describedBy,
      'aria-invalid': error ? true : undefined,
      'aria-required': required ? true : undefined,
    },
    controlId,
    description: schema.description ? (
      <p className="text-muted-foreground text-xs" id={descriptionId}>
        {schema.description}
      </p>
    ) : null,
    errorText: error ? (
      <p className="text-destructive text-xs" id={errorId}>
        {error}
      </p>
    ) : null,
    label: (
      <>
        {schema.title ?? name}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </>
    ),
  };
}

function BooleanField(props: FieldProps) {
  const { disabled, name, onChange, value } = props;
  const chrome = useFieldChrome(props);
  return (
    <div className="space-y-1" data-testid={`mcp-elicitation-field-${name}`}>
      <div className="flex items-center gap-2">
        <Checkbox
          {...chrome.aria}
          checked={value === true}
          disabled={disabled}
          id={chrome.controlId}
          onCheckedChange={(checked) => onChange(checked === true)}
        />
        <Label htmlFor={chrome.controlId}>{chrome.label}</Label>
      </div>
      {chrome.description}
      {chrome.errorText}
    </div>
  );
}

function MultiSelectField(props: FieldProps) {
  const { disabled, name, onChange, schema, value } = props;
  const chrome = useFieldChrome(props);
  const selected = Array.isArray(value) ? value : [];
  return (
    <fieldset
      {...chrome.aria}
      className="space-y-1"
      data-testid={`mcp-elicitation-field-${name}`}
      disabled={disabled}
    >
      <legend className="font-medium text-sm">{chrome.label}</legend>
      {chrome.description}
      <div className="space-y-1">
        {readMcpElicitationFieldOptions(schema).map((option) => {
          const optionId = `${chrome.controlId}-${option.value}`;
          const without = selected.filter((entry) => entry !== option.value);
          return (
            <div className="flex items-center gap-2" key={option.value}>
              <Checkbox
                checked={selected.includes(option.value)}
                disabled={disabled}
                id={optionId}
                onCheckedChange={(checked) =>
                  onChange(checked === true ? [...without, option.value] : without)
                }
              />
              <Label htmlFor={optionId}>{option.label}</Label>
            </div>
          );
        })}
      </div>
      {chrome.errorText}
    </fieldset>
  );
}

function SingleSelectField(props: FieldProps) {
  const { disabled, name, onChange, schema, value } = props;
  const chrome = useFieldChrome(props);
  return (
    <div className="space-y-1" data-testid={`mcp-elicitation-field-${name}`}>
      <Label htmlFor={chrome.controlId}>{chrome.label}</Label>
      <Select
        disabled={disabled}
        onValueChange={onChange}
        value={typeof value === 'string' ? value : ''}
      >
        <SelectTrigger {...chrome.aria} id={chrome.controlId}>
          <SelectValue placeholder="Choose a value" />
        </SelectTrigger>
        <SelectContent>
          {readMcpElicitationFieldOptions(schema).map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chrome.description}
      {chrome.errorText}
    </div>
  );
}

function inputConstraints(schema: McpElicitationPrimitiveSchemaWire): {
  readonly max?: number;
  readonly maxLength?: number;
  readonly min?: number;
  readonly placeholder?: string;
  readonly step?: number | string;
} {
  if (schema.type === 'number' || schema.type === 'integer') {
    return {
      ...(typeof schema.maximum === 'number' ? { max: schema.maximum } : {}),
      ...(typeof schema.minimum === 'number' ? { min: schema.minimum } : {}),
      step: schema.type === 'integer' ? 1 : 'any',
    };
  }
  if (schema.type === 'string' && !('enum' in schema) && !('oneOf' in schema)) {
    return {
      ...(typeof schema.maxLength === 'number' ? { maxLength: schema.maxLength } : {}),
      ...(schema.format === 'date-time' ? { placeholder: '2026-01-31T12:00:00Z' } : {}),
    };
  }
  return {};
}

function TextField(props: FieldProps) {
  const { disabled, name, onChange, schema, value } = props;
  const chrome = useFieldChrome(props);
  return (
    <div className="space-y-1" data-testid={`mcp-elicitation-field-${name}`}>
      <Label htmlFor={chrome.controlId}>{chrome.label}</Label>
      <Input
        {...chrome.aria}
        {...inputConstraints(schema)}
        disabled={disabled}
        id={chrome.controlId}
        onChange={(event) => onChange(event.target.value)}
        type={inputTypeFor(schema)}
        value={typeof value === 'string' ? value : ''}
      />
      {chrome.description}
      {chrome.errorText}
    </div>
  );
}

function ElicitationField(props: FieldProps) {
  switch (describeMcpElicitationField(props.schema)) {
    case 'boolean':
      return <BooleanField {...props} />;
    case 'multi-select':
      return <MultiSelectField {...props} />;
    case 'single-select':
      return <SingleSelectField {...props} />;
    default:
      return <TextField {...props} />;
  }
}

export function McpElicitationDialog({
  onDismissRetired,
  onSettle,
  presentation,
  retiredCode,
}: McpElicitationDialogProps) {
  const idPrefix = useId();
  const declineRef = useRef<HTMLButtonElement | null>(null);
  // When a request is retired the footer the user was focused on unmounts;
  // the Dismiss button mounts in its place and takes focus so keyboard users
  // are not dropped onto the dialog container.
  const focusDismissOnMount = useCallback((node: HTMLButtonElement | null) => {
    node?.focus();
  }, []);
  const [values, setValues] = useState<McpElicitationFieldValues>(() =>
    presentation.mode === 'form'
      ? initialMcpElicitationFieldValues(presentation.requestedSchema)
      : {}
  );
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const busy = settling || retiredCode !== undefined;
  const label = serverLabel(presentation.provenance);
  const summaryId = `${idPrefix}-summary`;

  const settle = async (settlement: McpElicitationSettlement): Promise<void> => {
    setSettling(true);
    setSettleError(null);
    try {
      await onSettle(settlement);
    } catch (error) {
      setSettleError(error instanceof Error ? error.message : String(error));
      setSettling(false);
    }
  };
  const accept = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (presentation.mode === 'url') {
      void settle({ ...settlementBase(presentation), action: 'accept' });
      return;
    }
    const outcome = buildMcpElicitationContent(presentation.requestedSchema, values);
    if (!outcome.ok) {
      setFieldErrors(outcome.errors);
      return;
    }
    setFieldErrors({});
    void settle({ ...settlementBase(presentation), action: 'accept', content: outcome.content });
  };
  const respond = (action: 'cancel' | 'decline'): void => {
    if (busy) {
      return;
    }
    void settle({ ...settlementBase(presentation), action });
  };
  const errorMessages = Object.entries(fieldErrors);

  return (
    <Dialog onOpenChange={() => undefined} open={true}>
      <DialogContent
        aria-busy={settling || undefined}
        className="max-w-lg"
        data-testid="mcp-elicitation-dialog"
        hideCloseButton
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (retiredCode === undefined) {
            declineRef.current?.focus();
          }
        }}
      >
        {/* noValidate: the mirrored validator below reports every problem in
            one accessible alert instead of the browser's per-field bubbles. */}
        <form
          className="space-y-4"
          data-testid={`mcp-elicitation-${presentation.mode}-${presentation.id}`}
          noValidate
          onSubmit={accept}
        >
          <DialogHeader>
            <DialogTitle>
              {presentation.mode === 'url'
                ? `${label} wants to open a link`
                : `${label} is requesting input`}
            </DialogTitle>
            <DialogDescription>{describeProvenance(presentation.provenance)}</DialogDescription>
          </DialogHeader>
          <p className="whitespace-pre-wrap text-sm" id={summaryId}>
            {presentation.message}
          </p>
          {presentation.mode === 'url' ? (
            <div className="space-y-2">
              <p className="text-muted-foreground text-xs">
                Accepting opens this exact address in your external browser. Nothing opens until you
                accept; declining or cancelling never opens it.
              </p>
              <code
                className="block break-all rounded-md border bg-muted px-3 py-2 font-mono text-xs"
                data-testid="mcp-elicitation-url"
              >
                {presentation.url}
              </code>
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(presentation.requestedSchema.properties).map(([name, schema]) => (
                <ElicitationField
                  disabled={busy}
                  error={fieldErrors[name]}
                  idPrefix={idPrefix}
                  key={name}
                  name={name}
                  onChange={(next) => setValues((previous) => ({ ...previous, [name]: next }))}
                  required={presentation.requestedSchema.required?.includes(name) ?? false}
                  schema={schema}
                  value={values[name] ?? ''}
                />
              ))}
            </div>
          )}
          {errorMessages.length > 0 ? (
            <div className="text-destructive text-sm" role="alert">
              <p>Fix the highlighted fields before accepting.</p>
              <ul className="list-disc pl-5">
                {errorMessages.map(([name, message]) => (
                  <li key={name}>
                    {name}: {message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {settleError ? (
            <p className="text-destructive text-sm" role="alert">
              {settleError}
            </p>
          ) : null}
          {retiredCode === undefined ? (
            <DialogFooter>
              <Button
                aria-label={`Cancel MCP request from ${label}`}
                disabled={busy}
                onClick={() => respond('cancel')}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                aria-label={`Decline MCP request from ${label}`}
                disabled={busy}
                onClick={() => respond('decline')}
                ref={declineRef}
                type="button"
                variant="outline"
              >
                Decline
              </Button>
              <Button
                aria-label={
                  presentation.mode === 'url'
                    ? `Accept and open link from ${label}`
                    : `Accept and send input to ${label}`
                }
                disabled={busy}
                type="submit"
              >
                {presentation.mode === 'url' ? 'Accept and open' : 'Accept'}
              </Button>
            </DialogFooter>
          ) : (
            <div className="space-y-2" role="alert">
              <p className="text-sm">
                This request is no longer pending ({retiredCode}). The server withdrew it, the
                connection changed, or it was answered elsewhere; no answer can be sent.
              </p>
              <DialogFooter>
                <Button
                  aria-label={`Dismiss retired MCP request from ${label}`}
                  onClick={onDismissRetired}
                  ref={focusDismissOnMount}
                  type="button"
                >
                  Dismiss
                </Button>
              </DialogFooter>
            </div>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}
