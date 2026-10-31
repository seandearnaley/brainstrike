// @vitest-environment jsdom
/**
 * The page's target facts, read from real markup and decided by the guard
 * (BST-2375): script-driven pages without a `<form>`, and fields that join a
 * form from outside it with `form="id"`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type BrowserAction,
  blockedActionCategory,
  decodeTargetFacts,
} from '../browser-action-guard';
import { TARGET_FACTS_FUNCTION } from '../browser-page-functions';

const readFacts = new Function(`return ${TARGET_FACTS_FUNCTION}`)() as (this: Element) => unknown;

beforeAll(() => {
  // jsdom has no layout, so no innerText; the visible text is the text here.
  Object.defineProperty(HTMLElement.prototype, 'innerText', {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent;
    },
  });
});

function decide(html: string, selector: string, action: BrowserAction, arrange?: () => void) {
  document.body.innerHTML = html;
  arrange?.();
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`No ${selector} in the fixture`);
  }
  const facts = decodeTargetFacts(readFacts.call(element));
  if (!facts.connected) {
    throw new Error('The fixture element is not connected');
  }
  return blockedActionCategory(facts, action);
}

const click = { kind: 'click' } as const;
const enter = (text: string) => ({ kind: 'type', submit: true, text }) as const;

const SCRIPTED_LOGIN = `
  <div class="login">
    <input id="email" placeholder="Email">
    <input id="secret" type="password">
    <div role="button" id="go"><span>Sign in</span></div>
  </div>`;

describe('target facts on pages without a form (BST-2375)', () => {
  it('refuses the sign-in button of a script-driven login, wherever the click lands in it', () => {
    expect(decide(SCRIPTED_LOGIN, '#go', click)).toBe('credential');
    expect(decide(SCRIPTED_LOGIN, '#go span', click)).toBe('credential');
    const buttonRow = `
      <div class="login">
        <input id="email"><input id="secret" type="password">
        <div class="actions"><button id="signin">Sign in</button><input type="submit" id="go2" value="Go"><button>Cancel</button></div>
      </div>`;
    expect(decide(buttonRow, '#signin', click)).toBe('credential');
    expect(decide(buttonRow, '#go2', click)).toBe('credential');
    expect(decide(SCRIPTED_LOGIN, '#email', { kind: 'type', submit: false, text: 'a@b.c' })).toBe(
      'credential'
    );
  });

  it('refuses Enter on a script-driven checkout whose button places the order', () => {
    const checkout = `
      <div class="checkout">
        <input id="note" placeholder="Gift note">
        <button id="buy">Place order</button>
      </div>`;
    expect(decide(checkout, '#note', enter('Happy birthday'))).toBe('purchase');
  });

  it('lets ordinary formless controls through', () => {
    const page = `
      <header><input id="q" placeholder="Search"><button id="find">Search</button></header>
      <main><button id="more">Load more</button></main>`;
    expect(decide(page, '#q', enter('red shoes'))).toBeUndefined();
    expect(decide(page, '#find', click)).toBeUndefined();
    expect(decide(page, '#more', click)).toBeUndefined();
  });

  it('leaves a formless button beside a real login form to that form', () => {
    const page = `
      <div class="profile">
        <label>Name <input id="name"></label>
        <button id="save" type="button">Save</button>
      </div>
      <form id="login"><input type="password" value="typed"><button>Sign in</button></form>
      <label>Size <input id="size"></label>
      <button id="apply" type="button">Apply</button>`;
    expect(decide(page, '#save', click)).toBeUndefined();
    // Directly under <body>, nothing stands in for a form.
    expect(decide(page, '#apply', click)).toBeUndefined();
  });

  it('counts a password field that joins the login form from outside it', () => {
    const page = `
      <form id="login"><input id="user" name="username"><button id="send">Continue</button></form>
      <input form="login" type="password" name="secret">`;
    expect(decide(page, '#send', click)).toBe('credential');
  });

  it('finds the login fields though a control named "elements" shadows the form property', () => {
    const page = `
      <form id="login">
        <input type="hidden" name="elements">
        <input type="password" name="secret">
        <button id="send">Continue</button>
      </form>`;
    // jsdom does not expose a form's named controls as its properties; a browser does.
    const shadow = () => {
      const form = document.querySelector('form');
      Object.defineProperty(form, 'elements', { value: form?.querySelector('[name=elements]') });
    };
    expect(decide(page, '#send', click, shadow)).toBe('credential');
  });
});
