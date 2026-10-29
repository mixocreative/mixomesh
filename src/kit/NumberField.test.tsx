import { describe, it, expect, vi, afterEach } from 'vitest';

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NumberField, type NumberFieldProps } from './NumberField';

afterEach(cleanup);
import { parseNumber } from './numberParse';

function setup(props: Partial<NumberFieldProps> = {}) {
  const onInput = vi.fn();
  const onCommit = vi.fn();
  render(<NumberField label="Width" value={10} unit="mm" min={0} max={100} step={1} onInput={onInput} onCommit={onCommit} {...props} />);
  return { onInput, onCommit, input: screen.getByLabelText('Width') as HTMLInputElement };
}

describe('parseNumber', () => {
  it('reads units, comma decimals, full-width digits', () => {
    expect(parseNumber('2mm', 'mm')).toBe(2);
    expect(parseNumber('2,5 mm', 'mm')).toBe(2.5);
    expect(parseNumber('１２', 'mm')).toBe(12);
    expect(parseNumber('45°', 'deg')).toBe(45);
    expect(parseNumber('1.5x', '×')).toBe(1.5);
    expect(parseNumber('1.5×', '×')).toBe(1.5);
    expect(parseNumber('abc', 'mm')).toBeUndefined();
    expect(parseNumber('', 'mm')).toBeUndefined();
  });
});

describe('NumberField', () => {
  it('renders label, value and unit', () => {
    const { input } = setup();
    expect(input.value).toBe('10');
    expect(screen.getByText('mm')).toBeTruthy();
  });
  it('typed text parses units and commits on Enter, not while typing', () => {
    const { input, onCommit, onInput } = setup();
    fireEvent.change(input, { target: { value: '12,5mm' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith(12.5);
    expect(onInput).not.toHaveBeenCalled();
  });
  it('clamps to min and max', () => {
    const { input, onCommit } = setup();
    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(100);
    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenLastCalledWith(0);
  });
  it('Escape reverts; junk and unchanged values do not commit', () => {
    const { input, onCommit } = setup();
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('10');
    fireEvent.change(input, { target: { value: 'junk' } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });
  it('arrow keys step and commit; Shift x10; clamped', () => {
    const { input, onCommit } = setup({ value: 98 });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(onCommit).toHaveBeenLastCalledWith(99);
    fireEvent.keyDown(input, { key: 'ArrowUp', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(100);
    fireEvent.keyDown(input, { key: 'ArrowDown', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(88);
  });
  it('label scrub: onInput while dragging, one onCommit on release, clamped', () => {
    const { onInput, onCommit } = setup({ step: 0.5 });
    const label = screen.getByText('Width');
    fireEvent.pointerDown(label, { button: 0, clientX: 100 });
    fireEvent(document, new MouseEvent('pointermove', { clientX: 108 }));
    expect(onInput).toHaveBeenLastCalledWith(11); // 8px / 4 * 0.5
    fireEvent(document, new MouseEvent('pointermove', { clientX: 100000 }));
    expect(onInput).toHaveBeenLastCalledWith(100);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent(document, new MouseEvent('pointerup'));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(100);
  });
  it('a click on the label without movement commits nothing', () => {
    const { onCommit } = setup();
    fireEvent.pointerDown(screen.getByText('Width'), { button: 0, clientX: 5 });
    fireEvent(document, new MouseEvent('pointerup'));
    expect(onCommit).not.toHaveBeenCalled();
  });
  it('disabled blocks scrub', () => {
    const { onInput } = setup({ disabled: true });
    fireEvent.pointerDown(screen.getByText('Width'), { button: 0, clientX: 0 });
    fireEvent(document, new MouseEvent('pointermove', { clientX: 50 }));
    expect(onInput).not.toHaveBeenCalled();
  });
});
