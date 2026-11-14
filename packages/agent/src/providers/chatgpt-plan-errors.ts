/**
 * OpenAI's refusals of a request paid by a ChatGPT plan (ADR-0038), as its
 * Sign in with ChatGPT guide lists them, with what the person can do:
 * https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *
 * Each becomes a refusal: OpenAI never moves such a request to another way of
 * paying, and sending it again spends the plan without changing the answer.
 */
import { CHATGPT_USAGE_URL, refusalError } from '@brainstrike/assistant-contract';
import { Predicate } from 'effect';

type PlanRefusal = readonly [
  category: 'authorization' | 'availability' | 'configuration',
  code: string,
  message: string,
  remedy: string,
];

const SIGN_IN_AGAIN = 'Sign in again in Settings → Providers.';
const NOT_AUTHORIZED: PlanRefusal = [
  'authorization',
  'provider.chatgpt-not-authorized',
  "This ChatGPT sign-in isn't authorized for this request.",
  `${SIGN_IN_AGAIN} You can also check Brainstrike's access at ${CHATGPT_USAGE_URL}.`,
];
const TRY_LATER = 'Try again in a moment.';

/** Keyed by OpenAI's error code. */
const PLAN_REFUSALS: ReadonlyMap<string, PlanRefusal> = new Map([
  ['chatpass_v2_invalid_authorization_context', NOT_AUTHORIZED],
  ['chatpass_v2_scope_not_authorized', NOT_AUTHORIZED],
  [
    'subscription_sharing_invalid_user',
    [
      'authorization',
      'provider.chatgpt-sign-in-invalid',
      'This ChatGPT sign-in is no longer valid.',
      SIGN_IN_AGAIN,
    ],
  ],
  [
    'subscription_sharing_unsupported_capability',
    [
      'configuration',
      'provider.chatgpt-unsupported-request',
      "This request uses something a ChatGPT plan doesn't cover here.",
      'Send it with a model from another provider, such as OpenAI with an API key.',
    ],
  ],
  [
    'subscription_sharing_usage_limit_exceeded',
    [
      'availability',
      'provider.chatgpt-usage-limit',
      'You reached a usage limit of your ChatGPT plan, or the one you set for Brainstrike.',
      `Review and manage your usage at ${CHATGPT_USAGE_URL}.`,
    ],
  ],
  [
    'subscription_sharing_usage_unavailable',
    [
      'availability',
      'provider.chatgpt-usage-unavailable',
      "ChatGPT can't check your plan's usage right now.",
      TRY_LATER,
    ],
  ],
  [
    'subscription_sharing_user_not_eligible',
    [
      'authorization',
      'provider.chatgpt-not-eligible',
      "This ChatGPT account or workspace can't use its plan in other apps.",
      'Choose a model from another provider, such as OpenAI with an API key.',
    ],
  ],
  [
    'subscription_sharing_user_unavailable',
    [
      'availability',
      'provider.chatgpt-account-unavailable',
      'Your ChatGPT account is temporarily unavailable.',
      TRY_LATER,
    ],
  ],
  [
    'subscription_sharing_workplace_individual_usage_limit_exceeded',
    [
      'availability',
      'provider.chatgpt-workspace-limit',
      'You reached the usage limit your ChatGPT workspace admin set for you.',
      'Ask your workspace admin to raise it.',
    ],
  ],
]);

/** OpenAI's JSON error envelope, which the SDK keeps as `APICallError.responseBody`. */
function errorEnvelope(value: Record<string, unknown>): unknown {
  const body = value['responseBody'];
  if (typeof body !== 'string') {
    return;
  }
  try {
    const envelope: unknown = JSON.parse(body);
    return Predicate.isObject(envelope) ? envelope['error'] : undefined;
  } catch {
    return;
  }
}

/** The plan refusal an HTTP error or a `response.failed` stream event carries, if any. */
function planRefusal(error: unknown): PlanRefusal | undefined {
  const visited = new WeakSet<object>();
  const visit = (value: unknown): PlanRefusal | undefined => {
    if (!Predicate.isObject(value) || visited.has(value)) {
      return;
    }
    visited.add(value);
    const code = value['code'];
    // An HTTP refusal keeps OpenAI's envelope as `responseBody`; a stream's
    // `response.failed` event arrives as the event itself, under `value`.
    return (
      (typeof code === 'string' ? PLAN_REFUSALS.get(code) : undefined) ??
      visit(errorEnvelope(value)) ??
      visit(value['error']) ??
      visit(value['response']) ??
      visit(value['value']) ??
      visit(value['cause'])
    );
  };
  return visit(error);
}

export function classifyChatGptPlanError(error: unknown): unknown {
  const refusal = planRefusal(error);
  return refusal ? refusalError(...refusal) : error;
}
