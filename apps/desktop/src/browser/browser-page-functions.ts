/**
 * The functions the agent's acting tools run IN the page (BST-2324), through
 * CDP `Runtime.callFunctionOn` with `this` bound to the ref's element.
 *
 * They are source strings, not TypeScript functions: the page receives their
 * text, so a bundler helper or a closed-over name would break them there.
 * Each is self-contained ES2020 and reads or changes only the element it is
 * called on (and, for facts, that element's form).
 *
 * `FILL_FUNCTION` and `SELECT_OPTIONS_FUNCTION` follow Playwright's injected
 * `fill`/`selectText` and `selectOptions` (packages/injected/src/injectedScript.ts),
 * the behaviour models and people already expect from browser automation.
 */

/**
 * Attribute facts about the target and its form (or, on a page without one,
 * the fields around it), for the hard blocks (BST-2209). Reads only; no event
 * fires. `fields` is capped so a huge form cannot flood the reply.
 */
export const TARGET_FACTS_FUNCTION = `function () {
  const el = this && this.nodeType === 1 ? this : this && this.parentElement;
  if (!el || !el.isConnected) {
    return { connected: false };
  }
  const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : '');
  const CAPTCHA = '.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]';
  const field = (node) => {
    const labels = node.labels ? Array.from(node.labels, (label) => label.textContent || '') : [];
    const hints = [
      node.getAttribute('name'),
      node.id,
      node.getAttribute('aria-label'),
      node.getAttribute('placeholder'),
      ...labels,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\\s+/g, ' ')
      .toLowerCase()
      .slice(0, 500);
    return {
      autocomplete: lower(node.getAttribute('autocomplete')).split(/\\s+/).filter(Boolean),
      hints,
      type: lower(node.tagName) === 'input' ? lower(node.getAttribute('type') || 'text') : '',
    };
  };
  const label = (node) =>
    (node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('alt') || '')
      .toString()
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 300);
  // The \`type\` property, not the attribute: a button with no type, or one
  // the browser does not know, submits.
  const isSubmitButton = (node) =>
    ['button', 'input'].includes(lower(node.tagName)) && (node.type === 'submit' || node.type === 'image');
  const FIELDS = 'input, select, textarea';
  const BUTTONS = 'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';
  const tag = lower(el.tagName);
  const form = el.form || el.closest('form');
  // Without a form, a script-driven page groups its fields in some container:
  // the nearest one holding another field or button stands in for the form,
  // and any button in it may send its fields. Whether a field is filled is not asked: the
  // browser hides an autofilled password's value until the page is touched.
  let group = null;
  if (!form) {
    for (let node = el.parentElement; node && !group; node = node.parentElement) {
      const controls = node.querySelectorAll(FIELDS + ', ' + BUTTONS);
      if (Array.from(controls).some((control) => control !== el && !el.contains(control))) {
        group = node;
      }
    }
  }
  // A form's own properties can be shadowed by a control's name (an input
  // named "elements"), so its controls are found from the tree: each names its
  // form in \`node.form\`, wherever its \`form="id"\` attribute puts it.
  const formControls = form
    ? Array.from(el.getRootNode().querySelectorAll('button, ' + FIELDS)).filter(
        (node) => node.form === form
      )
    : [];
  // HTML's implicit submission presses the form's first submit button in tree order.
  const defaultButton = form
    ? formControls.find(isSubmitButton)
    : group && group.querySelector(BUTTONS);
  const fields = form
    ? formControls.filter((node) => node.matches(FIELDS))
    : group
      ? Array.from(group.querySelectorAll(FIELDS))
      : [];
  const scope = form || group;
  return {
    captcha: Boolean(el.closest(CAPTCHA)),
    connected: true,
    disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
    form: scope
      ? {
          captcha: Boolean(scope.querySelector(CAPTCHA)),
          fields: fields.slice(0, 200).map(field),
          submitText: defaultButton ? label(defaultButton) : '',
        }
      : null,
    submits: form ? isSubmitButton(el) : Boolean(group) && Boolean(el.closest(BUTTONS)),
    tag,
    text: label(el),
    ...field(el),
  };
}`;

/**
 * Prepare a fill, as Playwright's `fill` does: set-value input types take the
 * value directly and fire input/change ('done'); text-like fields get their
 * content selected and focused for the caller's `Input.insertText`
 * ('needsinput'). Anything else throws with a message the model can act on.
 */
export const FILL_FUNCTION = `function (value) {
  const el = this;
  const SET_VALUE = new Set(['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week']);
  const TYPE_INTO = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'input') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (!TYPE_INTO.has(type) && !SET_VALUE.has(type)) {
      throw new Error('Input of type "' + type + '" cannot be filled');
    }
    if (type === 'number' && Number.isNaN(Number(value.trim()))) {
      throw new Error('Cannot type text into input[type=number]');
    }
    if (SET_VALUE.has(type)) {
      const next = type === 'color' ? value.trim().toLowerCase() : value.trim();
      el.focus();
      el.value = next;
      if (el.value !== next) {
        throw new Error('Malformed value for input[type=' + type + ']');
      }
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'done';
    }
    el.select();
    el.focus();
    return 'needsinput';
  }
  if (tag === 'textarea') {
    el.selectionStart = 0;
    el.selectionEnd = el.value.length;
    el.focus();
    return 'needsinput';
  }
  if (!el.isContentEditable) {
    throw new Error('Element is not an <input>, <textarea> or [contenteditable] element');
  }
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  const selection = el.ownerDocument.defaultView.getSelection();
  if (selection) {
    selection.removeAllRanges();
    selection.addRange(range);
  }
  el.focus();
  return 'needsinput';
}`;

/**
 * Select options by value or label, as Playwright's `selectOptions` does for
 * string options: every requested option must match an enabled option, a
 * single select takes the first match, and input/change fire once.
 */
export const SELECT_OPTIONS_FUNCTION = `function (wanted) {
  const el = this;
  if (!el.tagName || el.tagName.toLowerCase() !== 'select') {
    throw new Error('Element is not a <select> element');
  }
  const normalize = (text) => text.replace(/\\s+/g, ' ').trim();
  const options = Array.from(el.options);
  const remaining = wanted.slice();
  const selected = [];
  for (const option of options) {
    const index = remaining.findIndex(
      (value) => option.value === value || option.label === value || normalize(option.label) === normalize(value)
    );
    if (index === -1) {
      continue;
    }
    if (option.disabled) {
      throw new Error('Option "' + remaining[index] + '" is disabled');
    }
    selected.push(option);
    remaining.splice(index, 1);
    if (!el.multiple) {
      break;
    }
  }
  if (remaining.length > 0 && (el.multiple || selected.length === 0)) {
    throw new Error('No option matches ' + remaining.map((value) => JSON.stringify(value)).join(', '));
  }
  el.value = undefined;
  for (const option of options) {
    option.selected = selected.includes(option);
  }
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return selected.map((option) => option.value);
}`;

/**
 * Whether a click at viewport point (x, y) lands on this element or inside
 * it, crossing shadow roots. Otherwise names what is on top, so the model can
 * close an overlay instead of clicking it.
 */
export const HIT_TEST_FUNCTION = `function (x, y) {
  const root = this.getRootNode();
  const hit = (root && root.elementFromPoint ? root : document).elementFromPoint(x, y);
  for (let node = hit; node; node = node.parentNode || node.host) {
    if (node === this) {
      return null;
    }
  }
  if (!hit) {
    return 'nothing';
  }
  const label = (hit.getAttribute('aria-label') || hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  return '<' + hit.tagName.toLowerCase() + '>' + (label ? ' "' + label + '"' : '');
}`;
