import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptNextFactoryResetConfirmation,
  FACTORY_RESET_PROMPT,
} from './factory-reset-confirmation.ts';

function withConfirmation(original, run) {
  const messages = [];
  const names = ['confirm', 'm2FactoryResetConfirmationObserved'];
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, 'confirm', {
    configurable: true,
    value: original,
    writable: true,
  });
  Object.defineProperty(globalThis, 'm2FactoryResetConfirmationObserved', {
    configurable: true,
    value: (message) => messages.push(message),
    writable: true,
  });
  try {
    run(messages);
  } finally {
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    });
  }
}

test('one accepted native reset decision is observed and restores the original before reset work', () => {
  const original = () => false;
  withConfirmation(original, (messages) => {
    acceptNextFactoryResetConfirmation(FACTORY_RESET_PROMPT);
    // biome-ignore lint/suspicious/noAlert: Node unit test invokes the stubbed native confirmation input, not a browser dialog.
    assert.equal(globalThis.confirm(FACTORY_RESET_PROMPT), true);
    assert.deepEqual(messages, [FACTORY_RESET_PROMPT]);
    assert.equal(globalThis.confirm, original);
    // biome-ignore lint/suspicious/noAlert: Verifies restoration using the Node test stub.
    assert.equal(globalThis.confirm('An unrelated later confirmation'), false);
  });
});

test('an unrelated prompt is refused without observation and the original is restored', () => {
  const original = () => false;
  withConfirmation(original, (messages) => {
    acceptNextFactoryResetConfirmation(FACTORY_RESET_PROMPT);
    // biome-ignore lint/suspicious/noAlert: The Node stub must reject an unrelated confirmation input.
    assert.throws(() => globalThis.confirm('Delete a workspace file?'), /production Factory Reset/);
    assert.deepEqual(messages, []);
    assert.equal(globalThis.confirm, original);
  });
});

test('missing native confirmation capability fails explicitly', () => {
  withConfirmation(undefined, () =>
    assert.throws(
      () => acceptNextFactoryResetConfirmation(FACTORY_RESET_PROMPT),
      /capability is unavailable/
    )
  );
});

test('missing confirmation evidence observer fails before replacing native confirmation', () => {
  const original = () => false;
  withConfirmation(original, () => {
    Reflect.deleteProperty(globalThis, 'm2FactoryResetConfirmationObserved');
    assert.throws(
      () => acceptNextFactoryResetConfirmation(FACTORY_RESET_PROMPT),
      /observer is unavailable/
    );
    assert.equal(globalThis.confirm, original);
  });
});
