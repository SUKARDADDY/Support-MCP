import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Each test starts with no saved tabs, theme or account choice.
beforeEach(() => localStorage.clear());
afterEach(() => cleanup());
