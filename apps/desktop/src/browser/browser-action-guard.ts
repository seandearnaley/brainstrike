/**
 * The hard blocks on the agent's browser writes (BST-2209), decided before any
 * input reaches the page. They hold under every access mode, grant and
 * instruction: the agent never logs in, enters payment details, answers a
 * CAPTCHA or completes a purchase. A refusal is a typed `blocked_action` the
 * model reads as final; nothing is sent to the page.
 *
 * Pure: the facts come from `TARGET_FACTS_FUNCTION` in the page, and the
 * decision is made here, so every rule is testable without a browser.
 */
import { Schema } from 'effect';

const ActionFieldFactsSchema = Schema.Struct({
  /** `autocomplete` tokens, lowercased. */
  autocomplete: Schema.Array(Schema.String),
  /** name, id, aria-label, placeholder and label text, lowercased. */
  hints: Schema.String,
  /** An `<input>`'s type, lowercased; empty for other elements. */
  type: Schema.String,
});

/** One form field as the page describes it. */
export type ActionFieldFacts = typeof ActionFieldFactsSchema.Type;

/**
 * What `TARGET_FACTS_FUNCTION` returns. Decoded, never cast: a page or
 * protocol that answers in another shape fails the action instead of passing
 * the blocks with missing facts.
 */
const TargetFactsSchema = Schema.Union([
  Schema.Struct({ connected: Schema.Literal(false) }),
  Schema.Struct({
    ...ActionFieldFactsSchema.fields,
    /** The element sits inside a reCAPTCHA, hCaptcha or Turnstile widget. */
    captcha: Schema.Boolean,
    connected: Schema.Literal(true),
    disabled: Schema.Boolean,
    form: Schema.NullOr(
      Schema.Struct({
        /** The form holds a CAPTCHA widget. */
        captcha: Schema.Boolean,
        fields: Schema.Array(ActionFieldFactsSchema),
      })
    ),
    /** Clicking it submits its form. */
    submits: Schema.Boolean,
    tag: Schema.String,
    /** Its visible text or label, whitespace-collapsed. */
    text: Schema.String,
  }),
]);

export const decodeTargetFacts = Schema.decodeUnknownSync(TargetFactsSchema, { errors: 'all' });

/** The ref's element and its form, as the page reports them. */
export type ActionTargetFacts = Extract<
  typeof TargetFactsSchema.Type,
  { readonly connected: true }
>;

export type BrowserAction =
  | { readonly kind: 'click' }
  | { readonly kind: 'select'; readonly values: readonly string[] }
  | { readonly kind: 'type'; readonly submit: boolean; readonly text: string };

export type BlockedActionCategory = 'captcha' | 'credential' | 'payment' | 'purchase';

const CREDENTIAL_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);
const CREDENTIAL_HINT =
  /\b(?:password|passcode|passwd|one[\s_-]?time[\s_-]?(?:code|password)|otp|2fa|mfa)\b/u;
const CARD_HINT =
  /\b(?:card[\s_-]?(?:number|no|num|holder|name)|cardnumber|cc[\s_-]?(?:num|number|exp|cvc|cvv|csc)|credit[\s_-]?card|cvc|cvv|csc|security[\s_-]?code|expir(?:y|ation)(?:[\s_-]?date)?)\b/u;
const CAPTCHA_HINT = /captcha/u;
/**
 * Controls that complete a purchase. "Add to cart" and "Checkout" (which opens
 * the checkout page) are not purchases; placing the order is.
 */
const PURCHASE_TEXT =
  /\b(?:place (?:your |my )?order|buy (?:it )?now|complete (?:your |my )?(?:purchase|order|payment)|confirm (?:and pay|purchase|payment|(?:your |my )?order)|pay now|submit (?:order|payment)|purchase(?: now)?)\b|\bpay\s*[$€£¥]\s*\d/iu;

function isCredentialField(field: ActionFieldFacts): boolean {
  return (
    field.type === 'password' ||
    field.autocomplete.some((token) => CREDENTIAL_AUTOCOMPLETE.has(token)) ||
    CREDENTIAL_HINT.test(field.hints)
  );
}

function isPaymentField(field: ActionFieldFacts): boolean {
  return field.autocomplete.some((token) => token.startsWith('cc-')) || CARD_HINT.test(field.hints);
}

/** A Luhn-valid 13–19 digit run, spaces or dashes allowed between digits. */
export function containsCardNumber(text: string): boolean {
  for (const match of text.matchAll(/\d(?:[ -]?\d){12,18}/gu)) {
    const digits = match[0].replace(/\D/gu, '');
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      return true;
    }
  }
  return false;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (const [index, char] of [...digits].reverse().entries()) {
    const digit = Number(char) * (index % 2 === 1 ? 2 : 1);
    sum += digit > 9 ? digit - 9 : digit;
  }
  return sum % 10 === 0;
}

/** The category an action falls in, or undefined when it may proceed. */
export function blockedActionCategory(
  target: ActionTargetFacts,
  action: BrowserAction
): BlockedActionCategory | undefined {
  const formFields = target.form?.fields ?? [];
  const submitsForm =
    action.kind === 'click' ? target.submits : action.kind === 'type' && action.submit;
  if (target.captcha || CAPTCHA_HINT.test(target.hints) || (submitsForm && target.form?.captcha)) {
    return 'captcha';
  }
  if (action.kind === 'type') {
    // Any field of a login form is part of signing in.
    if (isCredentialField(target) || formFields.some(isCredentialField)) {
      return 'credential';
    }
    if (isPaymentField(target) || containsCardNumber(action.text)) {
      return 'payment';
    }
  }
  if (action.kind === 'select' && isPaymentField(target)) {
    return 'payment';
  }
  if (action.kind === 'click' && PURCHASE_TEXT.test(target.text)) {
    return 'purchase';
  }
  if (submitsForm && formFields.some(isPaymentField)) {
    return 'purchase';
  }
  return undefined;
}

const BLOCKED_ACTION_REASON: Readonly<Record<BlockedActionCategory, string>> = {
  captcha: 'it answers or submits a CAPTCHA',
  credential: 'it enters sign-in details (a password, one-time code or login form)',
  payment: 'it enters payment details',
  purchase: 'it completes a purchase',
};

/** What the model reads: final, and whose turn it is. */
export function blockedActionHint(category: BlockedActionCategory): string {
  return `Refused (${category}): ${BLOCKED_ACTION_REASON[category]}, which only the user may do. This is final; do not retry or work around it. Ask the user to do this step in the browser pane themselves.`;
}
