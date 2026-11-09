import { expect, test } from 'vitest';
import { TUNING } from './App.jsx';

test('the app looks again as often as the plan says', () => {
  expect(TUNING.screenshotMs).toBe(3000); // a picture every 3 seconds while you drive and the tab is on screen
  expect(TUNING.taskCheckMs).toBe(15000); // a look for a running task every 15 seconds
  expect(TUNING.taskWaitS).toBe(25); // the status is held open for the longest wait the relay allows
  expect(TUNING.devicePollMs).toBe(15000);
});
