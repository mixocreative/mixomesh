import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Select } from './Select';

afterEach(cleanup);

const options = [{ value: 'x', label: 'Ex' }, { value: 'y', label: 'Why' }] as const;

describe('Select', () => {
  it('renders a labelled select showing the value', () => {
    render(<Select label="Axis" options={options} value="y" onChange={() => {}} />);
    expect((screen.getByLabelText('Axis') as HTMLSelectElement).value).toBe('y');
  });
  it('reports the chosen value; disabled select is disabled', () => {
    const fn = vi.fn();
    const { rerender } = render(<Select label="Axis" options={options} value="y" onChange={fn} />);
    fireEvent.change(screen.getByLabelText('Axis'), { target: { value: 'x' } });
    expect(fn).toHaveBeenCalledWith('x');
    rerender(<Select label="Axis" options={options} value="y" onChange={fn} disabled />);
    expect((screen.getByLabelText('Axis') as HTMLSelectElement).disabled).toBe(true);
  });
});
