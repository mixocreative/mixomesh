import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Button } from './Button';

afterEach(cleanup);

describe('Button', () => {
  it('renders variants as base.css classes', () => {
    render(<><Button variant="primary">P</Button><Button variant="danger">D</Button><Button>X</Button><Button variant="icon" aria-label="Add">+</Button></>);
    expect(screen.getByText('P').className).toBe('primary');
    expect(screen.getByText('D').className).toBe('danger');
    expect(screen.getByText('X').className).toBe('');
    expect(screen.getByLabelText('Add').className).toBe('mx-icon');
  });
  it('defaults to type=button, clicks, and respects disabled', () => {
    const fn = vi.fn();
    render(<><Button onClick={fn}>Go</Button><Button disabled onClick={fn}>Off</Button></>);
    expect(screen.getByText('Go').getAttribute('type')).toBe('button');
    fireEvent.click(screen.getByText('Go'));
    fireEvent.click(screen.getByText('Off'));
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('forwards the ref', () => {
    let el: HTMLButtonElement | null = null;
    render(<Button ref={(n) => { el = n; }}>R</Button>);
    expect(el).toBeInstanceOf(HTMLButtonElement);
  });
});
