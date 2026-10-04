import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import apiRouter, { handlers } from '../pages/api/[...route].js';
import { cardRoutes } from '../server/routes/cards.js';
import { financeRoutes } from '../server/routes/finance.js';
import { operationRoutes } from '../server/routes/operations.js';
import { salesRoutes } from '../server/routes/sales.js';

const response = () => ({
  statusCode: 200, body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  send(body) { this.body = body; return this; },
});

test('Next.js API 경로는 단일 통합 라우터뿐이다', () => {
  assert.deepEqual(readdirSync(new URL('../pages/api/', import.meta.url)), ['[...route].js']);
});

test('모든 공개 API가 중복 없이 기능별 그룹에 등록되어 있다', () => {
  const routeGroups = [salesRoutes, financeRoutes, cardRoutes, operationRoutes];
  const names = routeGroups.flatMap(group => Object.keys(group));
  const files = readdirSync(new URL('../server/api/', import.meta.url))
    .filter(file => file.endsWith('.js') && !file.startsWith('_'))
    .map(file => file.slice(0, -3));
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), files.sort());
  assert.deepEqual(Object.keys(handlers).sort(), files.sort());
});

test('기존 Toss Place 경로를 전달한다', async () => {
  const res = response();
  await apiRouter({ method: 'GET', query: { route: ['tossplace'] }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, service: 'timefit-tossplace-webhook' });
});

test('쿼리 경로가 없으면 URL에서 기존 경로를 읽는다', async () => {
  const res = response();
  await apiRouter({ method: 'GET', url: '/api/tossplace?health=1', query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.service, 'timefit-tossplace-webhook');
});

test('알 수 없는 경로는 404를 반환한다', async () => {
  const res = response();
  await apiRouter({ method: 'GET', query: { route: ['not-found'] }, headers: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, 'API route not found');
});

test('매출 예약 경로는 서버 설정이 없어도 인증 없는 GET을 먼저 거부한다', async () => {
  const res = response();
  await apiRouter({ method: 'GET', query: { route: ['sync-sales'] }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});
