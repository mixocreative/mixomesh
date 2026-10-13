import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, escapeAttr, safeImageSrc } from '../src/ui/renderSafe.js';

test('escapeHtml escapes ampersand', () => {
  assert.equal(escapeHtml('A & B'), 'A &amp; B');
});

test('escapeHtml escapes less-than', () => {
  assert.equal(escapeHtml('<div>'), '&lt;div&gt;');
});

test('escapeHtml escapes greater-than', () => {
  assert.equal(escapeHtml('x > y'), 'x &gt; y');
});

test('escapeHtml escapes double quotes', () => {
  assert.equal(escapeHtml('He said "hello"'), 'He said &quot;hello&quot;');
});

test('escapeHtml escapes single quotes', () => {
  assert.equal(escapeHtml("It's fine"), 'It&#39;s fine');
});

test('escapeHtml handles null and undefined as empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml coerces numbers to string', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(3.14), '3.14');
});

test('escapeHtml handles script payload (becomes inert text)', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
});

test('escapeHtml handles onerror payload (becomes inert text)', () => {
  assert.equal(escapeHtml('onerror="malicious()"'), 'onerror=&quot;malicious()&quot;');
});

test('escapeHtml prevents attribute breakout with quotes', () => {
  const input = '" data-x="y';
  const escaped = escapeHtml(input);
  // The closing quote is escaped, preventing breakout
  assert.equal(escaped, '&quot; data-x=&quot;y');
});

test('escapeHtml double-escapes already-escaped input', () => {
  // When given &amp; (already escaped), it escapes the & and semicolon
  const alreadyEscaped = '&amp;';
  const result = escapeHtml(alreadyEscaped);
  // & gets escaped to &amp;, so &amp; becomes &amp;amp;
  assert.equal(result, '&amp;amp;');
});

test('escapeAttr is an alias for escapeHtml', () => {
  assert.equal(escapeAttr('<test>'), escapeHtml('<test>'));
  assert.equal(escapeAttr('test & "quoted"'), escapeHtml('test & "quoted"'));
});

test('escapeHtml handles mixed special characters', () => {
  const input = '& < > " \'';
  const expected = '&amp; &lt; &gt; &quot; &#39;';
  assert.equal(escapeHtml(input), expected);
});

test('safeImageSrc returns escaped src for valid data URIs', () => {
  const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAA';
  const result = safeImageSrc(dataUri);
  assert.equal(result, dataUri); // Should be escaped (if it contained special chars) but in this case it's just returned
});

test('safeImageSrc returns empty string for invalid URIs', () => {
  assert.equal(safeImageSrc('http://example.com/image.png'), '');
  assert.equal(safeImageSrc('javascript:alert("xss")'), '');
  assert.equal(safeImageSrc('/path/to/image.png'), '');
});

test('safeImageSrc handles null and undefined as empty string', () => {
  assert.equal(safeImageSrc(null), '');
  assert.equal(safeImageSrc(undefined), '');
});
