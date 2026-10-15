import '@testing-library/jest-dom';
// Scales @testing-library/dom's waitFor/findBy budget by TEST_TIMEOUT_MULTIPLIER
// (BST-1299). Side-effect import; registers no hooks.
import './vitest.timeouts.setup.js';
import { cleanup } from '@testing-library/react';
import { installSharedTestSetup } from './shared-test-setup.js';

// Loads the DOM half (jest-dom matchers, Testing Library timeouts and cleanup)
// in every environment. `vitest.dom-aware.setup.ts` loads the same half, from
// `dom-test-setup.ts`, only where the environment provides a DOM.
installSharedTestSetup(cleanup);
