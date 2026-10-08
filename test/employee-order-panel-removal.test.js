import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('직원관리에서 별도 직원 표시 순서 섹션을 렌더링하지 않는다', () => {
  assert.doesNotMatch(main, /function EmployeeOrderPanel/);
  assert.doesNotMatch(main, /직원 표시 순서/);
  assert.doesNotMatch(main, /<EmployeeOrderPanel/);
  assert.doesNotMatch(styles, /\.employee-order-panel/);
});
