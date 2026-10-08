import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/management-accounts.css', import.meta.url), 'utf8');

test('스케줄 등록 직원을 부서별로 그룹화한다', () => {
  assert.match(main, /const filteredStaffGroups=/);
  assert.match(main, /const team=employee\.team\|\|'미분류'/);
  assert.match(main, /filteredStaffGroups\.map\(group=>/);
  assert.match(main, /className="staff-selection-group"/);
});

test('부서 헤더에 선택 현황과 부서 색을 표시한다', () => {
  assert.match(main, /--staff-group-color/);
  assert.match(main, /group\.employees\.filter\(employee=>staffIds\.includes\(employee\.id\)\)\.length/);
  assert.match(styles, /\.staff-selection-groups\{/);
  assert.match(styles, /background:var\(--staff-group-color/);
});
