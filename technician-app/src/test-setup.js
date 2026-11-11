import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// The screens load in steps, and a loaded machine (CI, or the review running both suites at once)
// can take longer than the 1 s default to show them. Waiting longer changes no result.
configure({ asyncUtilTimeout: 4000 });

// Each test starts with no saved tabs, theme or account choice.
beforeEach(() => localStorage.clear());

// A promise nobody handled fails the test it happened in, with the reason in the message.
// (Vitest also fails the whole run for one, but names no test when it comes late.) The screens'
// loops catch their own errors, so any that shows up here is a bug.
const unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0)); // let a rejection from the last tick surface
  process.off('unhandledRejection', onUnhandled);
  if (unhandled.length) throw new Error(`Unhandled rejection during this test: ${unhandled.map((r) => r?.stack ?? String(r)).join('\n')}`);
});
