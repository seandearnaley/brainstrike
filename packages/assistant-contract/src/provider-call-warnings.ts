/**
 * Provider CALL WARNINGS (BST-1701): what an AI SDK adapter reports it did NOT
 * do with a request — e.g. `{type:'unsupported', feature:'temperature',
 * details:'...will be ignored'}`. Silently dropping a user's explicit setting
 * is the silent degradation AGENTS.md forbids, so every warning is shown.
 *
 * This is the shared READ and PRESENTATION of one warning: the legacy Mastra
 * path records warnings under the model (`providers/provider-call-warnings.ts`)
 * and the CLI-first host commits them on each SDK `start-step` part. Both read
 * and word them here, so a warning reads the same on either path.
 *
 * TYPE-BLIND BY DESIGN: the spec's `SharedV4Warning` union carries
 * `unsupported`, `compatibility`, `deprecated` and `other`, and an adapter may
 * add more. Nothing here filters by `type`; the two text fields are read by
 * FIELD NAME (`feature`/`setting`, `details`/`message`), which keeps an unknown
 * type readable.
 */
import { type AssistantRunEventMetadata, boundRunEventReason } from './run-events.js';

export interface ProviderCallWarningOrigin {
  readonly modelId: string;
  readonly provider: string;
}

/**
 * One provider warning, normalized across the spec's four shapes. `type` stays
 * an open `string`: a consumer must survive an adapter that adds a fifth kind.
 */
export interface ProviderCallWarning {
  /** The provider's own explanation (`details` / `message`), when it gave one. */
  readonly detail?: string;
  /** Configured model that produced this warning, including persona pins. */
  readonly origin?: ProviderCallWarningOrigin;
  /** What the warning is ABOUT (`feature` / `setting`), when the shape names one. */
  readonly subject?: string;
  readonly type: string;
}

/**
 * The `type` recorded for an entry whose shape this consumer cannot read.
 * Deliberately still RECORDED: dropping an unreadable warning would recreate
 * the defect one layer down.
 */
export const UNRECOGNIZED_PROVIDER_WARNING_TYPE = 'unrecognized';

export const PROVIDER_CALL_WARNING_RUN_EVENT_KIND = 'provider.request.warned' as const;

/** Cap for the rendered + persisted detail. */
export const MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS = 240;
/** Reserve visible space for the explanation after the model identity. */
const MAX_PROVIDER_CALL_WARNING_ORIGIN_CHARS = 80;
/** The shared provider-text truncation marker. */
const TRUNCATION_MARKER = '… [truncated]';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return boundRunEventReason(value);
    }
  }
  return;
}

function clamp(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const room = maxChars - TRUNCATION_MARKER.length;
  return room <= 0
    ? value.slice(0, Math.max(0, maxChars))
    : `${value.slice(0, room)}${TRUNCATION_MARKER}`;
}

/**
 * Read one entry off a provider `warnings` array, by field name: `unsupported`
 * and `compatibility` carry `feature` + `details`, `deprecated` carries
 * `setting` + `message`, `other` carries `message` alone.
 */
export function readProviderCallWarning(value: unknown): ProviderCallWarning {
  if (typeof value === 'string' && value.length > 0) {
    return { detail: boundRunEventReason(value), type: UNRECOGNIZED_PROVIDER_WARNING_TYPE };
  }
  if (!isRecord(value)) {
    return { type: UNRECOGNIZED_PROVIDER_WARNING_TYPE };
  }
  const type = value['type'];
  const subject = readString(value, ['feature', 'setting']);
  const detail = readString(value, ['details', 'message']);
  return {
    ...(detail === undefined ? {} : { detail }),
    ...(subject === undefined ? {} : { subject }),
    type:
      typeof type === 'string' && type.length > 0
        ? boundRunEventReason(type)
        : UNRECOGNIZED_PROVIDER_WARNING_TYPE,
  };
}

/**
 * Per-type row headings: a map WITH A DEFAULT, not a filter, so an unknown
 * type still gets a row.
 */
const WARNING_LABELS: Readonly<Record<string, string>> = {
  compatibility: 'Provider used a compatibility mode',
  deprecated: 'Provider reported a deprecated setting',
  other: 'Provider reported a warning',
  unsupported: 'Provider ignored an unsupported setting',
  [UNRECOGNIZED_PROVIDER_WARNING_TYPE]: 'Provider reported a warning',
};

export function providerCallWarningLabel(warning: ProviderCallWarning): string {
  return WARNING_LABELS[warning.type] ?? 'Provider reported a warning';
}

/**
 * The visible sentence. Both fields are optional in the spec, so a warning
 * that carries neither still says something true rather than rendering blank.
 */
export function providerCallWarningDetail(warning: ProviderCallWarning): string {
  const parts = [warning.subject, warning.detail].filter(
    (part): part is string => part !== undefined
  );
  const body =
    parts.length === 0
      ? `The provider reported a "${warning.type}" warning about this request without any detail.`
      : parts.join(': ');
  const source =
    warning.origin === undefined
      ? ''
      : `${clamp(`${warning.origin.provider}/${warning.origin.modelId}`, MAX_PROVIDER_CALL_WARNING_ORIGIN_CHARS)}: `;
  return clamp(`${source}${body}`, MAX_PROVIDER_CALL_WARNING_DETAIL_CHARS);
}

/**
 * Content-free metadata: redaction is by KEY, so the keys stay descriptive and
 * carry no provider prose — the sentence lives in the detail.
 */
export function providerCallWarningMetadata(
  warning: ProviderCallWarning
): AssistantRunEventMetadata {
  return {
    ...(warning.subject === undefined ? {} : { feature: boundRunEventReason(warning.subject) }),
    ...(warning.origin === undefined
      ? {}
      : {
          modelId: boundRunEventReason(warning.origin.modelId),
          provider: boundRunEventReason(warning.origin.provider),
        }),
    warningType: boundRunEventReason(warning.type),
  };
}
