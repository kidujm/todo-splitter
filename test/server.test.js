'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { server, SITE_ORIGINS } = require('../server');

const SITE = 'https://todo-web.example';

let port;

before(
  () =>
    new Promise((resolve) => {
      SITE_ORIGINS.add(SITE);
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    })
);

after(() => new Promise((resolve) => server.close(resolve)));

function request({ method = 'GET', path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ── 허용한 외부 웹판에 여는 주소 ──────────── */

test('웹판은 서버 상태를 물어볼 수 있다', async () => {
  const res = await request({ path: '/api/health', headers: { Origin: SITE } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], SITE);
  const data = JSON.parse(res.body);
  assert.equal(data.ok, true);
  assert.equal(typeof data.claudeReady, 'boolean');
});

test('웹판이 쪼개기 전에 보내는 사전 확인에 허락을 준다', async () => {
  const res = await request({
    method: 'OPTIONS',
    path: '/api/split',
    headers: {
      Origin: SITE,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers['access-control-allow-origin'], SITE);
  assert.equal(res.headers['access-control-allow-private-network'], 'true');
  assert.match(res.headers['access-control-allow-headers'], /Content-Type/i);
});

test('웹판이라도 할일 목록은 열지 않는다', async () => {
  const read = await request({ path: '/api/todos', headers: { Origin: SITE } });
  assert.equal(read.status, 403);
  assert.equal(read.headers['access-control-allow-origin'], undefined);

  const preflight = await request({
    method: 'OPTIONS',
    path: '/api/todos',
    headers: { Origin: SITE, 'Access-Control-Request-Method': 'PUT' },
  });
  assert.equal(preflight.status, 403);
});

test('낯선 사이트는 쪼개기를 부를 수 없다', async () => {
  // 막히지 않으면 claude가 실제로 실행되니, 여기서 403이 나와야 한다
  const res = await request({ method: 'POST', path: '/api/split', headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('이 서버가 띄운 화면의 요청은 그대로 통과한다', async () => {
  const fromApp = await request({ path: '/api/health', headers: { Origin: 'http://localhost:4321' } });
  assert.equal(fromApp.status, 200);
  assert.equal(fromApp.headers['access-control-allow-origin'], undefined);

  const noOrigin = await request({ path: '/api/health' });
  assert.equal(noOrigin.status, 200);
});

test('잘못된 주소가 와도 서버가 멈추지 않는다', async () => {
  const bad = await request({ path: '/%' });
  assert.equal(bad.status, 400);
  const after = await request({ path: '/api/health' });
  assert.equal(after.status, 200);
});

test('localhost가 아닌 Host로 온 요청은 막는다 (DNS 리바인딩 방지)', async () => {
  const res = await request({ path: '/api/todos', headers: { Host: 'evil.example:4321' } });
  assert.equal(res.status, 403);
});

test('업무일지 날짜가 YYYY-MM-DD가 아니면 거절한다', async () => {
  const res = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ date: '../../x' });
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/worklog/preview', agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); }
    );
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(res, 400);
});
