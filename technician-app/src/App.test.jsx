import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { App } from './App.jsx';

test('the app renders its title', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Support' })).toBeInTheDocument();
});
