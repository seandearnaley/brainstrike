// DOM half of the shared Vitest setup: jest-dom matchers, the Testing Library
// async-util budget (BST-1299) and React Testing Library's `cleanup`.
// `vitest.setup.ts` loads it in every environment; `vitest.dom-aware.setup.ts`
// loads it only where the environment provides a DOM.
import '@testing-library/jest-dom';
// Scales @testing-library/dom's waitFor/findBy budget by TEST_TIMEOUT_MULTIPLIER
// (BST-1299). Side-effect import; registers no hooks.
import './vitest.timeouts.setup.js';

export { cleanup } from '@testing-library/react';
