import { decodeHTML } from 'entities';
import {
  balancedJsonCandidates,
  decodeJsonUnicodeEscapes,
  embeddedJsonStarts,
  parseJsonCandidate,
} from './embedded-json.js';
import {
  classifyEvidenceCredentialKey,
  type EvidenceSecretKind,
  isSafeEvidenceCredentialValue,
  scanEvidenceTextForSecrets,
  secretKindForCredentialLabel,
} from './evidence-secrets.js';

const MAX_TEXT_CHARACTERS = 1_048_576;
const MAX_TOTAL_TEXT_CHARACTERS = 1_048_576;
const MAX_EMBEDDED_JSON_WORK_CHARACTERS = 4_194_304;
const MAX_STRUCTURED_DEPTH = 64;
const MAX_STRUCTURED_NODES = 10_000;
const MAX_SERIALIZED_JSON_DEPTH = 4;
const MAX_EMBEDDED_JSON_CANDIDATES_TOTAL = 256;
const MAX_REPRESENTATION_DECODING_DEPTH = 4;

export type McpEvidenceSecretCode = 'scan_limit_exceeded' | 'secret_detected';

export interface McpEvidenceSecretIssue {
  readonly code: McpEvidenceSecretCode;
  readonly index?: number;
  readonly kind?: EvidenceSecretKind;
  readonly path: string;
}

export class McpEvidenceSecretError extends Error {
  readonly issue: McpEvidenceSecretIssue;

  constructor(issue: McpEvidenceSecretIssue, message: string) {
    super(`${issue.path}: ${message}`);
    this.name = 'McpEvidenceSecretError';
    this.issue = issue;
  }
}

interface ScanState {
  candidates: number;
  embeddedJsonCharacters: number;
  nodes: number;
  readonly seen: WeakSet<object>;
  textCharacters: number;
}

export interface EvidenceSanitizationSession {
  assertMetadataSanitized(value: unknown, path: string): void;
  assertTextSanitized(text: string, path: string): void;
  assertValueSanitized(value: unknown, path: string): void;
}

interface KeyMode {
  readonly classifyCredentialKeys: boolean;
  readonly trustedPaths: boolean;
}

const METADATA_KEY_MODE: KeyMode = {
  classifyCredentialKeys: false,
  trustedPaths: true,
};
const UNTRUSTED_KEY_MODE: KeyMode = {
  classifyCredentialKeys: true,
  trustedPaths: false,
};

export function assertEvidenceTextSanitized(text: string, path: string): void {
  createEvidenceSanitizationSession().assertTextSanitized(text, path);
}

export function assertEvidenceValueSanitized(value: unknown, path: string): void {
  createEvidenceSanitizationSession().assertValueSanitized(value, path);
}

/**
 * Scans a closed, already-validated schema. Its trusted field names remain in
 * diagnostics, while JSON decoded from schema string values is treated as
 * untrusted content and receives positional paths plus credential-key checks.
 */
export function assertEvidenceMetadataSanitized(value: unknown, path: string): void {
  createEvidenceSanitizationSession().assertMetadataSanitized(value, path);
}

export function createEvidenceSanitizationSession(): EvidenceSanitizationSession {
  const state = createScanState();
  return {
    assertMetadataSanitized: (value, path) => {
      scanValue(value, path, state, 0, 0, METADATA_KEY_MODE);
    },
    assertTextSanitized: (text, path) => {
      scanText(text, path, state, 0, 0);
    },
    assertValueSanitized: (value, path) => {
      scanValue(value, path, state, 0, 0, UNTRUSTED_KEY_MODE);
    },
  };
}

function createScanState(): ScanState {
  return {
    candidates: 0,
    embeddedJsonCharacters: 0,
    nodes: 0,
    seen: new WeakSet(),
    textCharacters: 0,
  };
}

function scanValue(
  value: unknown,
  path: string,
  state: ScanState,
  depth: number,
  serializedDepth: number,
  keyMode: KeyMode
): void {
  state.nodes += 1;
  if (state.nodes > MAX_STRUCTURED_NODES) {
    limit(path, 'structured node count exceeds the evidence scan limit');
  }
  if (depth > MAX_STRUCTURED_DEPTH) {
    limit(path, 'structured depth exceeds the evidence scan limit');
  }
  if (typeof value === 'string') {
    scanText(value, path, state, depth, serializedDepth);
    return;
  }
  if (typeof value !== 'object' || value === null || state.seen.has(value)) {
    return;
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      scanValue(value[index], `${path}[${index}]`, state, depth + 1, serializedDepth, keyMode);
    }
    return;
  }
  for (const [index, [key, entry]] of Object.entries(value).entries()) {
    const entryPath = keyMode.trustedPaths ? jsonPath(path, key) : `${path}{${index}}`;
    const valuePath = keyMode.trustedPaths ? entryPath : `${entryPath}.value`;
    scanText(key, `${entryPath}.key`, state, depth + 1, serializedDepth);
    const label = keyMode.classifyCredentialKeys ? classifyEvidenceCredentialKey(key) : undefined;
    if (label !== undefined) {
      assertDecodedCredentialValue(label, entry, valuePath);
    }
    scanValue(entry, valuePath, state, depth + 1, serializedDepth, keyMode);
  }
}

function scanText(
  text: string,
  path: string,
  state: ScanState,
  depth: number,
  serializedDepth: number
): void {
  assertTextSize(text, path);
  chargeTextCharacters(state, text.length, path);
  for (const variant of decodedTextVariants(text, path)) {
    assertTextSize(variant, path);
    const finding = scanEvidenceTextForSecrets(variant)[0];
    if (finding !== undefined) {
      secret(path, finding.kind, finding.index);
    }
    scanJsonText(variant, path, state, depth, serializedDepth);
  }
}

function decodedTextVariants(text: string, path: string): readonly string[] {
  const variants = [text];
  let current = text;
  for (let depth = 0; depth < MAX_REPRESENTATION_DECODING_DEPTH; depth += 1) {
    const next = decodeRepresentationLayer(current, path);
    if (next === current) {
      return variants;
    }
    variants.push(next);
    current = next;
  }
  if (decodeRepresentationLayer(current, path) !== current) {
    limit(path, 'representation decoding depth exceeds the evidence scan limit');
  }
  return variants;
}

function decodeRepresentationLayer(text: string, path: string): string {
  return decodePercentSequences(decodeJsonUnicodeEscapes(decodeHTML(text)), path);
}

function decodePercentSequences(text: string, path: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      limit(path, 'percent decoding failed for evidence text');
    }
  });
}

function scanJsonText(
  text: string,
  path: string,
  state: ScanState,
  depth: number,
  serializedDepth: number
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !(trimmed.includes('{') || trimmed.includes('['))) {
    return;
  }
  const parsedDocument = parseJsonCandidate(trimmed);
  if (parsedDocument !== undefined) {
    scanParsedValue(parsedDocument.value, path, state, depth, serializedDepth);
    return;
  }
  scanEmbeddedJson(text, path, state, depth, serializedDepth);
}

function scanEmbeddedJson(
  text: string,
  path: string,
  state: ScanState,
  depth: number,
  serializedDepth: number
): void {
  const remainingCandidates = MAX_EMBEDDED_JSON_CANDIDATES_TOTAL - state.candidates;
  const starts = embeddedJsonStarts(text, remainingCandidates);
  if (starts === undefined) {
    limit(path, 'embedded JSON candidate count exceeds the evidence scan limit');
  }
  state.candidates += starts.length;
  for (const [candidateIndex, start] of starts.entries()) {
    const candidateInput = text.slice(start);
    chargeEmbeddedJsonCharacters(state, candidateInput.length, path);
    const result = balancedJsonCandidates(candidateInput, MAX_SERIALIZED_JSON_DEPTH);
    const candidatePath = `${path}.embeddedJson[${candidateIndex}]`;
    if (result.decodingLimitExceeded) {
      limit(candidatePath, 'escaped JSON nesting exceeds the evidence scan limit');
    }
    for (const [variantIndex, candidate] of result.candidates.entries()) {
      const parsedCandidate = parseJsonCandidate(candidate);
      if (parsedCandidate !== undefined) {
        scanParsedValue(
          parsedCandidate.value,
          `${candidatePath}[${variantIndex}]`,
          state,
          depth,
          serializedDepth
        );
      }
    }
  }
}

function scanParsedValue(
  value: unknown,
  path: string,
  state: ScanState,
  depth: number,
  serializedDepth: number
): void {
  if (serializedDepth >= MAX_SERIALIZED_JSON_DEPTH) {
    limit(path, 'serialized JSON nesting exceeds the evidence scan limit');
  }
  scanValue(value, path, state, depth + 1, serializedDepth + 1, UNTRUSTED_KEY_MODE);
}

function assertDecodedCredentialValue(label: string, value: unknown, path: string): void {
  if (value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    if (value.length === 0 || isSafeEvidenceCredentialValue(label, value)) {
      return;
    }
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }
  } else if (isPlainRecord(value) && Object.keys(value).length === 0) {
    return;
  }
  secret(path, secretKindForCredentialLabel(label), 0);
}

function assertTextSize(text: string, path: string): void {
  if (text.length > MAX_TEXT_CHARACTERS) {
    limit(path, 'text size exceeds the evidence scan limit');
  }
}

function chargeTextCharacters(state: ScanState, characters: number, path: string): void {
  state.textCharacters += characters;
  if (state.textCharacters > MAX_TOTAL_TEXT_CHARACTERS) {
    limit(path, 'cumulative text size exceeds the evidence scan limit');
  }
}

function chargeEmbeddedJsonCharacters(state: ScanState, characters: number, path: string): void {
  state.embeddedJsonCharacters += characters;
  if (state.embeddedJsonCharacters > MAX_EMBEDDED_JSON_WORK_CHARACTERS) {
    limit(path, 'embedded JSON work exceeds the evidence scan limit');
  }
}

function jsonPath(path: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function secret(path: string, kind: EvidenceSecretKind, index: number): never {
  throw new McpEvidenceSecretError(
    { code: 'secret_detected', index, kind, path },
    `contains prohibited ${kind} material`
  );
}

function limit(path: string, message: string): never {
  throw new McpEvidenceSecretError({ code: 'scan_limit_exceeded', path }, message);
}
