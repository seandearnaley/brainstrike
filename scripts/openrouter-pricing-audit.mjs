#!/usr/bin/env node
// Audits every `openrouter` row in the static provider catalog against the
// live OpenRouter Models API and reports rows whose declared rate is not the
// route's BASE rate (BST-1705).
//
// WHY THE NAIVE READ IS WRONG. `pricing.prompt` / `pricing.completion` are the
// rate IN FORCE AT READ TIME, and two things in the same payload move it:
//
//   1. `pricing.overrides` entries keyed by `utc_days` / `utc_start` /
//      `utc_end` are TIME-OF-DAY SURGE bands that replace the base rate for
//      part of the week. An author who reads the API inside a peak window
//      records the surge rate as if it were the standing price. That is not
//      hypothetical: `tencent/hy3` shipped at 0.132 / 0.528 — its 00:00-16:00
//      UTC band — when its base is 0.0825 / 0.33.
//   2. `pricing.overrides` entries keyed by `min_prompt_tokens` are
//      LONG-CONTEXT TIERS (BST-1708). They are conditional on request size,
//      never on the clock, and this one-rate-pair catalog schema does not
//      carry them, so they must not displace the base rate either.
//
// Those two are the ONLY override shapes this audit recognises. Live read
// 2026-09-10: of the 65 routes carrying `pricing.overrides`, 63 are
// `min_prompt_tokens` tiers, 2 are clock bands, and 0 are anything else. A
// third shape must be READ and taught to this script, never guessed at — see
// `splitOverrides`.
//
// A third trap lives one route over: `<id>:batch`, `<id>:free` and `<id>:nitro`
// are SEPARATE routes with their own prices. `google/gemini-3.7-flash` and
// `z-ai/glm-5.3-flash` both shipped carrying their `:batch` twin's rate.
//
// So the audit does not compare against "the number the API returned". It
// derives the base rate with `deriveOpenRouterBaseRate`, whose answer does not
// depend on when it runs, and when a row disagrees it says WHICH of these
// mistakes the held number looks like.
//
// It also audits each row's LIMITS (BST-1804): `contextWindow` and
// `maxOutputTokens` must be the route's `top_provider` pair, because
// `contextWindow` sets the compaction limit and a larger model-level
// `context_length` may be served by one provider only. The model-level window
// is read ONLY where the top-provider window is explicitly null (router
// meta-models); a null top-provider output limit means the row omits one. An
// ABSENT top-provider field is an unreadable payload, never a fallback. See
// `auditOpenRouterLimits`.
//
// NOT A REQUIRED CI CHECK, deliberately. It needs the network, and OpenRouter
// re-prices roughly weekly, so wiring it into `lint:ci` would paint unrelated
// PRs red for upstream reasons. It is an on-demand catalog-authoring tool
// (`pnpm run audit:openrouter-pricing`); what IS pinned in the required lane
// is the derivation itself — scripts/__tests__/openrouter-pricing-audit.test.mjs
// runs offline against fixtures of every shape above, including a peak-window
// read, so the METHOD cannot regress even though the DATA lives upstream.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = 'packages/assistant-contract/src/provider-catalog.json';
const MODELS_API_URL = 'https://openrouter.ai/api/v1/models';
const PROVIDER_ID = 'openrouter';
const PER_TOKEN_TO_PER_MTOK = 1_000_000;
// A hung connection must not hang the command with no output. The whole
// payload is ~700 KB, so this is generous even on a slow link.
const FETCH_TIMEOUT_MS = 30_000;
// Prices are exact decimals upstream; this absorbs binary float representation
// only (0.00000008708 * 1e6 is not exactly 0.08708), never real drift.
const REPRESENTATION_EPSILON = 1e-9;
const MINUTES_PER_DAY = 24 * 60;
const UTC_DAYS = Object.freeze([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]);
const WEEK_MINUTES = UTC_DAYS.length * MINUTES_PER_DAY;
/** What makes an override entry a clock band. Any ONE of these is enough. */
const TIME_BAND_KEYS = Object.freeze(['utc_days', 'utc_start', 'utc_end']);
const CONTEXT_TIER_KEY = 'min_prompt_tokens';

class PricingShapeError extends Error {}

function parseRate(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PricingShapeError(`${label} is missing`);
  }
  // `Number('')` and `Number('   ')` are 0, which sails through the guard
  // below and records a paid route as free. Reject before coercing.
  if (typeof value === 'string' && value.trim() === '') {
    throw new PricingShapeError(`${label} is an empty string, not a rate`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new PricingShapeError(`${label} is not a non-negative number: ${String(value)}`);
  }
  return parsed * PER_TOKEN_TO_PER_MTOK;
}

function sameRate(left, right) {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= REPRESENTATION_EPSILON * scale;
}

function withinTolerance(held, base, tolerance) {
  const scale = Math.max(1, Math.abs(held), Math.abs(base));
  return (
    Math.abs(held - base) <= Math.max(REPRESENTATION_EPSILON * scale, tolerance * Math.abs(base))
  );
}

function samePair(left, right) {
  return (
    sameRate(left.inputPerMTok, right.inputPerMTok) &&
    sameRate(left.outputPerMTok, right.outputPerMTok)
  );
}

/** `utc_start`/`utc_end` are HHMM integers (1600 = 16:00). */
function hhmmToMinutes(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 2400) {
    throw new PricingShapeError(`${label} is not an HHMM integer: ${String(value)}`);
  }
  const hours = Math.floor(value / 100);
  const minutes = value % 100;
  if (hours > 24 || minutes > 59) {
    throw new PricingShapeError(`${label} is not a valid time of day: ${String(value)}`);
  }
  return hours * 60 + minutes;
}

function bandMinutes(band, label) {
  const days = band.utc_days ?? UTC_DAYS;
  if (!Array.isArray(days) || days.length === 0) {
    throw new PricingShapeError(`${label} declares an empty utc_days`);
  }
  const start = hhmmToMinutes(band.utc_start ?? 0, `${label} utc_start`);
  const rawEnd = hhmmToMinutes(band.utc_end ?? 0, `${label} utc_end`);
  // An end at or before the start wraps past midnight; `utc_end: 0` is
  // end-of-day, which is how OpenRouter writes a band that runs to midnight.
  const end = rawEnd <= start ? rawEnd + MINUTES_PER_DAY : rawEnd;
  const covered = [];
  for (const day of days) {
    const dayIndex = UTC_DAYS.indexOf(day);
    if (dayIndex < 0) {
      throw new PricingShapeError(`${label} names an unknown UTC day: ${String(day)}`);
    }
    for (let minute = start; minute < end; minute += 1) {
      covered.push((dayIndex * MINUTES_PER_DAY + minute) % WEEK_MINUTES);
    }
  }
  return covered;
}

/**
 * Sort `pricing.overrides` into the two shapes this audit understands, by
 * POSITIVE EVIDENCE for each.
 *
 * Classifying by elimination ("not a `min_prompt_tokens` tier, so it must be a
 * clock band") is fail-open, and expensively so: `bandMinutes` defaults every
 * absent UTC field, so an unrecognised entry becomes a band covering the whole
 * week and is then eligible to win the cheapest-band reduce in
 * `deriveOpenRouterBaseRate` — an override shape nobody has ever read could
 * silently BECOME the recorded base rate. An unknown or mixed discriminator is
 * therefore a payload for a human to read, not one to guess at.
 */
export function splitOverrides(pricing) {
  const overrides = pricing?.overrides ?? [];
  if (!Array.isArray(overrides)) {
    throw new PricingShapeError('pricing.overrides is not an array');
  }
  const timeBands = [];
  const contextTiers = [];
  for (const [index, override] of overrides.entries()) {
    if (override === null || typeof override !== 'object') {
      throw new PricingShapeError('pricing.overrides contains a non-object entry');
    }
    const keys = Object.keys(override).join(', ');
    const isContextTier = CONTEXT_TIER_KEY in override;
    const isTimeBand = TIME_BAND_KEYS.some((key) => key in override);
    if (isContextTier && isTimeBand) {
      throw new PricingShapeError(
        `pricing.overrides[${index}] mixes ${CONTEXT_TIER_KEY} with a time-band key (${keys}); a size-conditional band on a clock is a shape this audit has never read`
      );
    }
    if (isContextTier) {
      contextTiers.push(override);
      continue;
    }
    if (isTimeBand) {
      timeBands.push(override);
      continue;
    }
    throw new PricingShapeError(
      `pricing.overrides[${index}] declares no recognised discriminator — expected ${CONTEXT_TIER_KEY} or one of ${TIME_BAND_KEYS.join('/')}, got (${keys})`
    );
  }
  return { contextTiers, timeBands };
}

/**
 * A surge multiplier that never quietly reports "no surge": a free band beside
 * a paid one has no finite ratio, so say so rather than returning 1, which
 * reads as "this route does not surge".
 */
function surgeRatio(dearest, cheapest) {
  if (dearest === cheapest) {
    return 1;
  }
  return cheapest === 0 ? Number.POSITIVE_INFINITY : dearest / cheapest;
}

/**
 * Derive a route's BASE $/MTok rate pair from an OpenRouter `pricing` object.
 *
 * The answer must not depend on the wall clock at which the payload was
 * fetched, which is the whole defence against recording a surge rate. With no
 * clock bands the base IS the top-level rate. With clock bands the top-level
 * rate is the MOVING one and is ignored; the base is THE CHEAPEST BAND, taken
 * after proving the bands describe the entire week and that the top-level rate
 * is one of them.
 *
 * Cheapest band — NOT "the rate outside every band", and NOT the band covering
 * most of the week:
 *   - There is no outside. A payload whose bands leave any of the week
 *     uncovered is rejected outright a few lines below, because the base would
 *     then be visible only to a reader who fetched during the gap.
 *   - `tencent/hy3` surges for 16 of every 24 hours, so the band covering most
 *     of the week IS the surge band; a "modal band" rule reproduces the bug.
 * The known limit: a PROMOTIONAL band priced below the standing rate would be
 * read as the base. Nothing live does that (2026-09-10), and the payload
 * carries no field that distinguishes a discount window from a surge window,
 * so the rule stays and its limit is recorded rather than guessed around.
 *
 * Fails closed. An unrecognised shape THROWS rather than falling back to the
 * top-level rate, because a silent fallback here re-creates exactly the bug
 * this function exists to prevent.
 */
export function deriveOpenRouterBaseRate(pricing) {
  if (pricing === null || typeof pricing !== 'object') {
    throw new PricingShapeError('pricing is not an object');
  }
  const topLevel = {
    inputPerMTok: parseRate(pricing.prompt, 'pricing.prompt'),
    outputPerMTok: parseRate(pricing.completion, 'pricing.completion'),
  };
  const { timeBands } = splitOverrides(pricing);
  if (timeBands.length === 0) {
    return { ...topLevel, basis: 'flat', surgeMultiplier: 1 };
  }

  const parsedBands = timeBands.map((band, index) => ({
    inputPerMTok: parseRate(band.prompt, `pricing.overrides[${index}].prompt`),
    minutes: bandMinutes(band, `pricing.overrides[${index}]`),
    outputPerMTok: parseRate(band.completion, `pricing.overrides[${index}].completion`),
  }));

  const covered = new Set();
  for (const band of parsedBands) {
    for (const minute of band.minutes) {
      covered.add(minute);
    }
  }
  if (covered.size !== WEEK_MINUTES) {
    // A partially covered week means the base rate lives in the uncovered
    // hours and is only visible to a reader who happens to fetch then — i.e.
    // the derivation would become time-dependent again. Refuse to guess.
    throw new PricingShapeError(
      `surge bands cover ${covered.size} of ${WEEK_MINUTES} minutes; the base rate is not derivable from this payload`
    );
  }
  if (!parsedBands.some((band) => samePair(band, topLevel))) {
    // The top-level rate is supposed to BE one of the bands (whichever is in
    // force now). If it is not, this payload does not mean what we think.
    throw new PricingShapeError(
      'the top-level rate matches no surge band; the pricing shape is not the one this audit understands'
    );
  }

  // Ordered on BOTH rates, so bands that tie on input do not resolve by
  // upstream array order: the answer may no more depend on how the payload is
  // written than on when it was fetched.
  const base = parsedBands.reduce((cheapest, band) => {
    if (band.inputPerMTok !== cheapest.inputPerMTok) {
      return band.inputPerMTok < cheapest.inputPerMTok ? band : cheapest;
    }
    return band.outputPerMTok < cheapest.outputPerMTok ? band : cheapest;
  });
  // Taken per dimension, so a band that surges OUTPUT only still reports a
  // multiplier above 1 instead of looking flat.
  const dearestInput = Math.max(...parsedBands.map((band) => band.inputPerMTok));
  const dearestOutput = Math.max(...parsedBands.map((band) => band.outputPerMTok));
  return {
    basis: 'off-peak-band',
    inputPerMTok: base.inputPerMTok,
    outputPerMTok: base.outputPerMTok,
    surgeMultiplier: Math.max(
      surgeRatio(dearestInput, base.inputPerMTok),
      surgeRatio(dearestOutput, base.outputPerMTok)
    ),
  };
}

/**
 * Name the mistake a stale row looks like, so the report tells an author
 * whether the number moved upstream or was read from the wrong place.
 */
export function classifyHeldRate({ held, live, variants = [] }) {
  const { contextTiers, timeBands } = splitOverrides(live.pricing);
  for (const [index, band] of timeBands.entries()) {
    const pair = {
      inputPerMTok: parseRate(band.prompt, `overrides[${index}].prompt`),
      outputPerMTok: parseRate(band.completion, `overrides[${index}].completion`),
    };
    if (samePair(pair, held)) {
      return 'surge-band';
    }
  }
  for (const [index, tier] of contextTiers.entries()) {
    const pair = {
      inputPerMTok: parseRate(tier.prompt, `overrides[${index}].prompt`),
      outputPerMTok: parseRate(tier.completion, `overrides[${index}].completion`),
    };
    if (samePair(pair, held)) {
      return 'long-context-tier';
    }
  }
  for (const variant of variants) {
    if (samePair(deriveOpenRouterBaseRate(variant.pricing), held)) {
      return `variant-route:${variant.id}`;
    }
  }
  return 'moved-upstream';
}

/**
 * The catalog row's own rate pair, or `null` when the row does not carry two
 * usable numbers. Comparing `undefined` against a live rate yields NaN, which
 * fails every comparison, so a malformed row would otherwise render as
 * `held undefined / undefined — moved-upstream`: a broken row reported as a
 * price movement.
 */
function readHeldRate(pricing) {
  const usable = (rate) => typeof rate === 'number' && Number.isFinite(rate) && rate >= 0;
  const { inputPerMTok, outputPerMTok } = pricing;
  if (!(usable(inputPerMTok) && usable(outputPerMTok))) {
    return null;
  }
  return { inputPerMTok, outputPerMTok };
}

/**
 * The drift itself is already established when this runs; only the LABEL is at
 * risk (a long-context tier or a variant route whose shape the derivation
 * cannot read). Report the drift with an explicit unclassified label rather
 * than losing the finding to an exception.
 */
function classifyDefensively(input) {
  try {
    return classifyHeldRate(input);
  } catch (error) {
    if (!(error instanceof PricingShapeError)) {
      throw error;
    }
    return `unclassified (${error.message})`;
  }
}

/**
 * Compare every `openrouter` catalog row against the live routes.
 * `tolerance` is a fraction of the base rate (0 means exact).
 *
 * A row whose live payload this audit cannot read becomes a
 * `shape-unrecognised` FINDING rather than an exception out of the loop. That
 * does not soften the fail-closed rule — the row is never treated as passing
 * and the command still exits 1 — it refuses to let one upstream shape change
 * turn a 58-row catalog diff into a single stack trace about one row.
 */
export function auditOpenRouterPricing({ catalog, liveModels, tolerance = 0 }) {
  const provider = catalog.find((entry) => entry.id === PROVIDER_ID);
  if (provider === undefined) {
    throw new Error(`the catalog has no "${PROVIDER_ID}" provider`);
  }
  const liveById = new Map(liveModels.map((model) => [model.id, model]));
  const findings = [];
  let audited = 0;

  for (const model of provider.models) {
    if (model.type !== undefined && model.type !== 'llm') {
      continue;
    }
    const held = model.pricing === undefined ? null : readHeldRate(model.pricing);
    if (held === null) {
      findings.push({ kind: 'unpriced-row', modelId: model.id });
      continue;
    }
    const live = liveById.get(model.id);
    if (live === undefined) {
      findings.push({ kind: 'route-missing', modelId: model.id });
      continue;
    }

    let base;
    try {
      base = deriveOpenRouterBaseRate(live.pricing);
    } catch (error) {
      if (!(error instanceof PricingShapeError)) {
        throw error;
      }
      findings.push({ kind: 'shape-unrecognised', modelId: model.id, reason: error.message });
      continue;
    }

    audited += 1;
    if (
      withinTolerance(held.inputPerMTok, base.inputPerMTok, tolerance) &&
      withinTolerance(held.outputPerMTok, base.outputPerMTok, tolerance)
    ) {
      continue;
    }
    findings.push({
      base,
      classification: classifyDefensively({
        held,
        live,
        variants: liveModels.filter((candidate) => candidate.id.startsWith(`${model.id}:`)),
      }),
      held,
      kind: 'price-drift',
      modelId: model.id,
    });
  }

  return { audited, findings };
}

/** `null` is a published "none"; anything else must be a positive integer. */
function readTopProviderLimit(topProvider, field) {
  const value = topProvider[field];
  if (value === null) {
    return null;
  }
  if (!(Number.isSafeInteger(value) && value > 0)) {
    throw new PricingShapeError(
      `top_provider.${field} is neither null nor a positive integer: ${String(value)}`
    );
  }
  return value;
}

/**
 * The pair an `openrouter` row must hold: the route's `top_provider` window and
 * output limit. The model-level `context_length` stands in ONLY when the top
 * provider publishes a null window (router meta-models); a null output limit
 * means the row declares none. Throws on an absent or malformed field rather
 * than falling back — an unread shape is for a human, not a default.
 */
export function deriveOpenRouterLimitPair(live) {
  const topProvider = live.top_provider;
  if (topProvider === null || typeof topProvider !== 'object') {
    throw new PricingShapeError('top_provider is not an object');
  }
  const topWindow = readTopProviderLimit(topProvider, 'context_length');
  const maxOutput = readTopProviderLimit(topProvider, 'max_completion_tokens');
  let contextWindow = topWindow;
  if (topWindow === null) {
    if (!(Number.isSafeInteger(live.context_length) && live.context_length > 0)) {
      throw new PricingShapeError(
        `top_provider.context_length is null and context_length is not a positive integer: ${String(live.context_length)}`
      );
    }
    contextWindow = live.context_length;
  }
  return { contextWindow, maxOutputTokens: maxOutput ?? undefined };
}

/**
 * Compare every `openrouter` LLM row's `contextWindow` / `maxOutputTokens`
 * against the live route's top-provider pair. Exact: these are integers
 * published verbatim, so there is no representation error to absorb.
 */
export function auditOpenRouterLimits({ catalog, liveModels }) {
  const provider = catalog.find((entry) => entry.id === PROVIDER_ID);
  if (provider === undefined) {
    throw new Error(`the catalog has no "${PROVIDER_ID}" provider`);
  }
  const liveById = new Map(liveModels.map((model) => [model.id, model]));
  const findings = [];
  let audited = 0;

  for (const model of provider.models) {
    if (model.type !== undefined && model.type !== 'llm') {
      continue;
    }
    const live = liveById.get(model.id);
    if (live === undefined) {
      findings.push({ kind: 'route-missing', modelId: model.id });
      continue;
    }
    let expected;
    try {
      expected = deriveOpenRouterLimitPair(live);
    } catch (error) {
      if (!(error instanceof PricingShapeError)) {
        throw error;
      }
      findings.push({ kind: 'limit-shape-unrecognised', modelId: model.id, reason: error.message });
      continue;
    }
    audited += 1;
    const held = { contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens };
    if (
      held.contextWindow === expected.contextWindow &&
      held.maxOutputTokens === expected.maxOutputTokens
    ) {
      continue;
    }
    findings.push({ expected, held, kind: 'limit-drift', modelId: model.id });
  }

  return { audited, findings };
}

function formatLimit(value) {
  return value === undefined ? 'none' : String(value);
}

function formatLimitFinding(finding) {
  if (finding.kind === 'route-missing') {
    return `  ${finding.modelId}: not published by the live Models API`;
  }
  if (finding.kind === 'limit-shape-unrecognised') {
    return `  ${finding.modelId}: live limit shape not understood — ${finding.reason}`;
  }
  const { expected, held } = finding;
  return [
    `  ${finding.modelId}: held ${formatLimit(held.contextWindow)} / ${formatLimit(held.maxOutputTokens)}`,
    `top provider ${formatLimit(expected.contextWindow)} / ${formatLimit(expected.maxOutputTokens)}`,
  ].join(' ');
}

export function summarizeLimitFindings({ audited, findings }) {
  const drifted = findings.filter((finding) => finding.kind === 'limit-drift').length;
  const notAudited = findings.length - drifted;
  const tail = notAudited === 0 ? '' : `; ${notAudited} row(s) could not be audited`;
  return `openrouter limits audit: ${drifted} of ${audited} audited routes disagree with the top-provider pair${tail}.`;
}

function formatFinding(finding) {
  if (finding.kind === 'route-missing') {
    return `  ${finding.modelId}: not published by the live Models API`;
  }
  if (finding.kind === 'unpriced-row') {
    return `  ${finding.modelId}: catalog row declares no usable inputPerMTok / outputPerMTok pair`;
  }
  if (finding.kind === 'shape-unrecognised') {
    return `  ${finding.modelId}: live pricing shape not understood — ${finding.reason}`;
  }
  const { base, held } = finding;
  return [
    `  ${finding.modelId}: held ${held.inputPerMTok} / ${held.outputPerMTok}`,
    `live base ${base.inputPerMTok} / ${base.outputPerMTok} (${base.basis})`,
    `— ${finding.classification}`,
  ].join(' ');
}

/**
 * `findings` mixes rows that WERE compared and disagreed with rows that could
 * not be compared at all, while `audited` counts only the former. Reporting
 * `findings.length` "of `audited`" prints ratios like "2 of 0".
 */
export function summarizeFindings({ audited, findings }) {
  const drifted = findings.filter((finding) => finding.kind === 'price-drift').length;
  const notAudited = findings.length - drifted;
  const tail = notAudited === 0 ? '' : `; ${notAudited} row(s) could not be audited`;
  return `openrouter pricing audit: ${drifted} of ${audited} audited routes disagree with the live base rate${tail}.`;
}

/** `--flag=value`, keeping any `=` inside the value and never accepting an empty one. */
export function readFlagValue(args, flag) {
  const prefix = `${flag}=`;
  const arg = args.find((candidate) => candidate.startsWith(prefix));
  if (arg === undefined) {
    return;
  }
  const value = arg.slice(prefix.length);
  if (value === '') {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** The Models API envelope, so a changed response shape fails by name. */
export function readModelsEnvelope(payload, source) {
  const data = payload === null || typeof payload !== 'object' ? undefined : payload.data;
  if (!Array.isArray(data)) {
    throw new Error(
      `${source} did not return the expected { "data": [ ... ] } Models API envelope`
    );
  }
  return data;
}

async function loadLiveModels(fixturePath) {
  if (fixturePath !== undefined) {
    return readModelsEnvelope(JSON.parse(await readFile(fixturePath, 'utf8')), fixturePath);
  }
  const response = await fetch(MODELS_API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${MODELS_API_URL} responded ${response.status} ${response.statusText}`);
  }
  return readModelsEnvelope(await response.json(), MODELS_API_URL);
}

async function main() {
  const args = process.argv.slice(2);
  const fixturePath = readFlagValue(args, '--fixture');
  const toleranceValue = readFlagValue(args, '--tolerance');
  const tolerance = toleranceValue === undefined ? 0 : Number(toleranceValue);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(`--tolerance must be a non-negative fraction, received ${toleranceValue}`);
  }

  const catalog = JSON.parse(await readFile(path.join(REPO_ROOT, CATALOG_PATH), 'utf8'));
  const liveModels = await loadLiveModels(fixturePath);
  const pricing = auditOpenRouterPricing({ catalog, liveModels, tolerance });
  const limits = auditOpenRouterLimits({ catalog, liveModels });

  if (pricing.findings.length === 0) {
    process.stdout.write(
      `openrouter pricing audit: ${pricing.audited} routes match their live base rate.\n`
    );
  } else {
    process.stderr.write(
      `${summarizeFindings(pricing)}\n${pricing.findings
        .map(formatFinding)
        .join(
          '\n'
        )}\n\nRecord the BASE rate (the cheapest time band) from the STANDARD route.\nSee the openrouter provider _note in packages/assistant-contract/src/provider-catalog.json.\n`
    );
    process.exitCode = 1;
  }

  if (limits.findings.length === 0) {
    process.stdout.write(
      `openrouter limits audit: ${limits.audited} routes match their top-provider pair.\n`
    );
    return;
  }
  process.stderr.write(
    `${summarizeLimitFindings(limits)}\n${limits.findings
      .map(formatLimitFinding)
      .join(
        '\n'
      )}\n\nRecord contextWindow / maxOutputTokens as the route's top_provider pair.\nSee docs/agents/assistant-providers.md, "Model pricing is per-ROUTE, not per-model".\n`
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
