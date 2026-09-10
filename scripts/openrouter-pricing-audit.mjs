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
// A third trap lives one route over: `<id>:batch`, `<id>:free` and `<id>:nitro`
// are SEPARATE routes with their own prices. `google/gemini-3.7-flash` and
// `z-ai/glm-5.3-flash` both shipped carrying their `:batch` twin's rate.
//
// So the audit does not compare against "the number the API returned". It
// derives the base rate with `deriveOpenRouterBaseRate`, whose answer does not
// depend on when it runs, and when a row disagrees it says WHICH of these
// mistakes the held number looks like.
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

class PricingShapeError extends Error {}

function parseRate(value, label) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PricingShapeError(`${label} is missing`);
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

export function splitOverrides(pricing) {
  const overrides = pricing?.overrides ?? [];
  if (!Array.isArray(overrides)) {
    throw new PricingShapeError('pricing.overrides is not an array');
  }
  const timeBands = [];
  const contextTiers = [];
  for (const override of overrides) {
    if (override === null || typeof override !== 'object') {
      throw new PricingShapeError('pricing.overrides contains a non-object entry');
    }
    if ('min_prompt_tokens' in override) {
      contextTiers.push(override);
      continue;
    }
    timeBands.push(override);
  }
  return { contextTiers, timeBands };
}

/**
 * Derive a route's BASE $/MTok rate pair — the rate an ordinary prompt pays
 * outside every surge band — from an OpenRouter `pricing` object.
 *
 * The answer must not depend on the wall clock at which the payload was
 * fetched, which is the whole defence against recording a surge rate. When
 * surge bands exist the derivation therefore ignores the top-level rate (that
 * is the moving one) and reads the cheapest band, after proving the bands
 * describe the entire week and that the top-level rate is one of them.
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

  const base = parsedBands.reduce((cheapest, band) =>
    band.inputPerMTok < cheapest.inputPerMTok ? band : cheapest
  );
  const peak = parsedBands.reduce((dearest, band) =>
    band.inputPerMTok > dearest.inputPerMTok ? band : dearest
  );
  return {
    basis: 'off-peak-band',
    inputPerMTok: base.inputPerMTok,
    outputPerMTok: base.outputPerMTok,
    surgeMultiplier: base.inputPerMTok === 0 ? 1 : peak.inputPerMTok / base.inputPerMTok,
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
 * Compare every `openrouter` catalog row against the live routes.
 * `tolerance` is a fraction of the base rate (0 means exact).
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
    if (model.pricing === undefined) {
      findings.push({ kind: 'unpriced-row', modelId: model.id });
      continue;
    }
    const live = liveById.get(model.id);
    if (live === undefined) {
      findings.push({ kind: 'route-missing', modelId: model.id });
      continue;
    }
    audited += 1;
    const base = deriveOpenRouterBaseRate(live.pricing);
    const held = {
      inputPerMTok: model.pricing.inputPerMTok,
      outputPerMTok: model.pricing.outputPerMTok,
    };
    if (
      withinTolerance(held.inputPerMTok, base.inputPerMTok, tolerance) &&
      withinTolerance(held.outputPerMTok, base.outputPerMTok, tolerance)
    ) {
      continue;
    }
    findings.push({
      base,
      classification: classifyHeldRate({
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

function formatFinding(finding) {
  if (finding.kind === 'route-missing') {
    return `  ${finding.modelId}: not published by the live Models API`;
  }
  if (finding.kind === 'unpriced-row') {
    return `  ${finding.modelId}: catalog row declares no pricing`;
  }
  const { base, held } = finding;
  return [
    `  ${finding.modelId}: held ${held.inputPerMTok} / ${held.outputPerMTok}`,
    `live base ${base.inputPerMTok} / ${base.outputPerMTok} (${base.basis})`,
    `— ${finding.classification}`,
  ].join(' ');
}

async function loadLiveModels(fixturePath) {
  if (fixturePath !== undefined) {
    return JSON.parse(await readFile(fixturePath, 'utf8')).data;
  }
  const response = await fetch(MODELS_API_URL);
  if (!response.ok) {
    throw new Error(`${MODELS_API_URL} responded ${response.status} ${response.statusText}`);
  }
  return (await response.json()).data;
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureArg = args.find((arg) => arg.startsWith('--fixture='));
  const toleranceArg = args.find((arg) => arg.startsWith('--tolerance='));
  const tolerance = toleranceArg === undefined ? 0 : Number(toleranceArg.split('=')[1]);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(
      `--tolerance must be a non-negative fraction, received ${String(toleranceArg)}`
    );
  }

  const catalog = JSON.parse(await readFile(path.join(REPO_ROOT, CATALOG_PATH), 'utf8'));
  const liveModels = await loadLiveModels(fixtureArg?.split('=')[1]);
  const { audited, findings } = auditOpenRouterPricing({ catalog, liveModels, tolerance });

  if (findings.length === 0) {
    process.stdout.write(
      `openrouter pricing audit: ${audited} routes match their live base rate.\n`
    );
    return;
  }
  process.stderr.write(
    `openrouter pricing audit: ${findings.length} of ${audited} routes disagree with the live Models API.\n${findings
      .map(formatFinding)
      .join(
        '\n'
      )}\n\nRecord the BASE rate (outside every surge band) from the STANDARD route.\nSee the openrouter provider _note in packages/assistant-contract/src/provider-catalog.json.\n`
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
