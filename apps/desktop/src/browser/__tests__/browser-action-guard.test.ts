import { describe, expect, it } from 'vitest';
import {
  type ActionFieldFacts,
  type ActionTargetFacts,
  blockedActionCategory,
  containsCardNumber,
} from '../browser-action-guard';

const field = (overrides: Partial<ActionFieldFacts> = {}): ActionFieldFacts => ({
  autocomplete: [],
  hints: '',
  type: 'text',
  ...overrides,
});

const target = (overrides: Partial<ActionTargetFacts> = {}): ActionTargetFacts => ({
  ...field(),
  captcha: false,
  connected: true,
  disabled: false,
  form: null,
  submits: false,
  tag: 'input',
  text: '',
  ...overrides,
});

const type = (text = 'hello', submit = false) => ({ kind: 'type', submit, text }) as const;
const click = { kind: 'click' } as const;

describe('blockedActionCategory (BST-2209)', () => {
  it('lets ordinary typing, clicking and choosing through', () => {
    expect(blockedActionCategory(target({ hints: 'search' }), type('red shoes'))).toBeUndefined();
    expect(
      blockedActionCategory(target({ tag: 'button', text: 'Add to cart' }), click)
    ).toBeUndefined();
    expect(
      blockedActionCategory(target({ tag: 'select', type: '' }), { kind: 'select', values: ['L'] })
    ).toBeUndefined();
  });

  it('refuses sign-in details: passwords, one-time codes and any field of a login form', () => {
    expect(blockedActionCategory(target({ type: 'password' }), type())).toBe('credential');
    expect(blockedActionCategory(target({ autocomplete: ['one-time-code'] }), type())).toBe(
      'credential'
    );
    const loginForm = {
      captcha: false,
      fields: [field({ hints: 'email' }), field({ type: 'password' })],
    };
    expect(blockedActionCategory(target({ form: loginForm, hints: 'email' }), type())).toBe(
      'credential'
    );
  });

  it('refuses payment fields and card numbers typed anywhere', () => {
    expect(blockedActionCategory(target({ autocomplete: ['cc-number'] }), type())).toBe('payment');
    expect(blockedActionCategory(target({ hints: 'cvv' }), type('123'))).toBe('payment');
    expect(
      blockedActionCategory(target({ hints: 'notes' }), type('card 4242 4242 4242 4242'))
    ).toBe('payment');
    expect(
      blockedActionCategory(target({ autocomplete: ['cc-exp-month'], tag: 'select', type: '' }), {
        kind: 'select',
        values: ['12'],
      })
    ).toBe('payment');
  });

  it('refuses CAPTCHA widgets and submitting a form that holds one', () => {
    expect(blockedActionCategory(target({ captcha: true, tag: 'div' }), click)).toBe('captcha');
    expect(blockedActionCategory(target({ hints: 'captcha answer' }), type('x7k2'))).toBe(
      'captcha'
    );
    const guarded = { captcha: true, fields: [field({ hints: 'email' })] };
    expect(
      blockedActionCategory(target({ form: guarded, submits: true, tag: 'button' }), click)
    ).toBe('captcha');
    // Filling the form's other fields is still fine.
    expect(
      blockedActionCategory(target({ form: guarded, hints: 'email' }), type())
    ).toBeUndefined();
  });

  it('refuses completing a purchase, but not getting to the checkout page', () => {
    for (const text of [
      'Place order',
      'Buy now',
      'Complete purchase',
      'Pay $42.00',
      'Confirm and pay',
    ]) {
      expect(blockedActionCategory(target({ tag: 'button', text }), click), text).toBe('purchase');
    }
    expect(
      blockedActionCategory(target({ tag: 'a', text: 'Proceed to checkout' }), click)
    ).toBeUndefined();
    const paymentForm = { captcha: false, fields: [field({ autocomplete: ['cc-number'] })] };
    expect(
      blockedActionCategory(
        target({ form: paymentForm, submits: true, tag: 'button', text: 'Next' }),
        click
      )
    ).toBe('purchase');
    expect(
      blockedActionCategory(target({ form: paymentForm, hints: 'zip' }), type('02139', true))
    ).toBe('purchase');
  });
});

describe('containsCardNumber', () => {
  it('finds Luhn-valid card numbers, spaced or dashed, and nothing else', () => {
    expect(containsCardNumber('4242424242424242')).toBe(true);
    expect(containsCardNumber('5555-5555-5555-4444')).toBe(true);
    expect(containsCardNumber('order 4242 4242 4242 4241')).toBe(false);
    expect(containsCardNumber('call 617 555 0100')).toBe(false);
  });
});
