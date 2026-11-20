'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../lib/notifier');

/** 로컬 시각으로 Date 하나. 테스트가 시간대에 흔들리지 않게 로컬로만 만든다. */
function at(y, mo, d, h, mi) {
  return new Date(y, mo - 1, d, h, mi, 0, 0);
}

function todo(over = {}) {
  return {
    id: over.id || 'x',
    title: over.title || '할 일',
    priority: over.priority || 'normal',
    done: over.done === true,
    remindAt: 'remindAt' in over ? over.remindAt : null,
    remindedAt: 'remindedAt' in over ? over.remindedAt : null,
  };
}

const NOW = at(2026, 9, 5, 14, 0);

test('시각이 지난 알림만 골라낸다', () => {
  const { fire } = N.pickDue(
    [
      todo({ id: 'past', remindAt: '2026-09-05T13:59' }),
      todo({ id: 'now', remindAt: '2026-09-05T14:00' }),
      todo({ id: 'future', remindAt: '2026-09-05T14:01' }),
    ],
    NOW
  );
  assert.deepEqual(fire.map((t) => t.id), ['past', 'now']);
});

test('이미 울린 알림은 다시 울리지 않는다', () => {
  const { fire } = N.pickDue(
    [todo({ id: 'sent', remindAt: '2026-09-05T13:00', remindedAt: '2026-09-05T13:00:05.000Z' })],
    NOW
  );
  assert.equal(fire.length, 0);
});

test('끝낸 할일은 울리지 않는다', () => {
  const { fire } = N.pickDue([todo({ id: 'done', remindAt: '2026-09-05T13:00', done: true })], NOW);
  assert.equal(fire.length, 0);
});

test('알림 시각이 없거나 형식이 틀리면 건너뛴다', () => {
  const { fire } = N.pickDue(
    [
      todo({ id: 'none', remindAt: null }),
      todo({ id: 'dateonly', remindAt: '2026-09-05' }),
      todo({ id: 'junk', remindAt: '내일 두시' }),
      todo({ id: 'badtime', remindAt: '2026-09-05T25:00' }),
    ],
    NOW
  );
  assert.equal(fire.length, 0);
});

test('서버가 꺼진 사이 지나간 알림은 켜지면 울린다', () => {
  // 12시간 안쪽이면 늦게라도 알려주는 게 낫다
  const { fire, stale } = N.pickDue([todo({ id: 'missed', remindAt: '2026-09-05T09:00' })], NOW);
  assert.deepEqual(fire.map((t) => t.id), ['missed']);
  assert.equal(stale.length, 0);
});

test('12시간보다 오래된 알림은 조용히 지나간 것으로 처리한다', () => {
  // 주말 내내 꺼 뒀다가 켰을 때 묵은 팝업이 쏟아지면 안 된다
  const { fire, stale } = N.pickDue(
    [
      todo({ id: 'old', remindAt: '2026-09-05T01:00' }),
      todo({ id: 'ancient', remindAt: '2026-09-01T10:00' }),
    ],
    NOW
  );
  assert.equal(fire.length, 0);
  assert.deepEqual(stale.map((t) => t.id), ['old', 'ancient']);
});

test('경계: 정확히 12시간 전은 아직 울린다', () => {
  const { fire, stale } = N.pickDue([todo({ id: 'edge', remindAt: '2026-09-05T02:00' })], NOW);
  assert.deepEqual(fire.map((t) => t.id), ['edge']);
  assert.equal(stale.length, 0);
});

test('snoozeAt은 지금부터 n분 뒤를 로컬 문자열로 준다', () => {
  assert.equal(N.snoozeAt(NOW, 10), '2026-09-05T14:10');
  assert.equal(N.snoozeAt(at(2026, 9, 5, 23, 55), 10), '2026-09-06T00:05');
  assert.equal(N.snoozeAt(at(2026, 12, 31, 23, 50), 30), '2027-01-01T00:20');
});

test('markSent는 울린 표시를 남기고 원본을 바꾼다', () => {
  const t = todo({ id: 'a', remindAt: '2026-09-05T13:00' });
  N.markSent(t, NOW);
  assert.equal(typeof t.remindedAt, 'string');
  assert.equal(t.remindAt, '2026-09-05T13:00'); // 언제 울렸는지 알 수 있게 남겨 둔다
});

test('applySnooze는 알림을 미루고 다시 울릴 수 있게 만든다', () => {
  const t = todo({ id: 'a', remindAt: '2026-09-05T13:00', remindedAt: '2026-09-05T13:00:05.000Z' });
  N.applySnooze(t, 10, NOW);
  assert.equal(t.remindAt, '2026-09-05T14:10');
  assert.equal(t.remindedAt, null);

  const { fire } = N.pickDue([t], at(2026, 9, 5, 14, 10));
  assert.deepEqual(fire.map((x) => x.id), ['a']);
});

test('급함은 창, 나머지는 토스트로 간다', () => {
  assert.equal(N.popupKind(todo({ priority: 'high' })), 'window');
  assert.equal(N.popupKind(todo({ priority: 'normal' })), 'toast');
  assert.equal(N.popupKind(todo({ priority: 'low' })), 'toast');
});

/* ── 브라우저 저장과의 경합 ──────────────────
   브라우저는 자기가 들고 있는 목록 전체를 PUT으로 덮어쓴다.
   알림이 울린 직후 브라우저가 저장하면 '울림' 표시가 지워져 같은 알림이 또 뜬다. */

test('알림 시각이 그대로면 울림 표시를 지키다', () => {
  const disk = [todo({ id: 'a', remindAt: '2026-09-05T14:00', remindedAt: '2026-09-05T05:00:00.000Z' })];
  const fromBrowser = [todo({ id: 'a', remindAt: '2026-09-05T14:00', remindedAt: null })];

  const merged = N.preserveSent(fromBrowser, disk);
  assert.equal(merged[0].remindedAt, '2026-09-05T05:00:00.000Z');
});

test('사용자가 알림 시각을 바꿨으면 다시 울릴 수 있게 둔다', () => {
  const disk = [todo({ id: 'a', remindAt: '2026-09-05T14:00', remindedAt: '2026-09-05T05:00:00.000Z' })];
  const fromBrowser = [todo({ id: 'a', remindAt: '2026-09-05T16:00', remindedAt: null })];

  const merged = N.preserveSent(fromBrowser, disk);
  assert.equal(merged[0].remindedAt, null);
});

test('알림을 아예 지웠으면 울림 표시도 남기지 않는다', () => {
  const disk = [todo({ id: 'a', remindAt: '2026-09-05T14:00', remindedAt: '2026-09-05T05:00:00.000Z' })];
  const fromBrowser = [todo({ id: 'a', remindAt: null, remindedAt: null })];

  const merged = N.preserveSent(fromBrowser, disk);
  assert.equal(merged[0].remindedAt, null);
});

test('새로 만든 할일은 손대지 않는다', () => {
  const merged = N.preserveSent([todo({ id: 'new', remindAt: '2026-09-05T14:00' })], []);
  assert.equal(merged[0].remindedAt, null);
  assert.equal(merged.length, 1);
});

test('preserveSent는 원본 배열을 바꾸지 않는다', () => {
  const disk = [todo({ id: 'a', remindAt: '2026-09-05T14:00', remindedAt: '2026-09-05T05:00:00.000Z' })];
  const fromBrowser = [todo({ id: 'a', remindAt: '2026-09-05T14:00', remindedAt: null })];

  N.preserveSent(fromBrowser, disk);
  assert.equal(fromBrowser[0].remindedAt, null, '들어온 배열은 그대로여야 한다');
});

test('스누즈로 서버가 미뤄 둔 알림을 브라우저가 되돌리지 않는다', () => {
  // 서버가 14:10으로 미뤘는데, 브라우저는 아직 14:00을 들고 있다
  const disk = [todo({ id: 'a', remindAt: '2026-09-05T14:10', remindedAt: null })];
  const fromBrowser = [todo({ id: 'a', remindAt: '2026-09-05T14:00', remindedAt: '2026-09-05T05:00:00.000Z' })];

  const merged = N.preserveSent(fromBrowser, disk);
  assert.equal(merged[0].remindAt, '2026-09-05T14:10');
  assert.equal(merged[0].remindedAt, null);
});
