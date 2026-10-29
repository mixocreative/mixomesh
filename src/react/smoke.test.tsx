import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

function Hello({ name }: { name: string }) {
  return <p data-testid="hello">Hello {name}</p>;
}

describe('react toolchain smoke', () => {
  it('renders a component through jsdom', () => {
    render(<Hello name="mesh" />);
    expect(screen.getByTestId('hello').textContent).toBe('Hello mesh');
  });
});
