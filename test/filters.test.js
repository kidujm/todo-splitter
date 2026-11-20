'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../lib/filters');

const TODAY = '2026-08-24';

function todo(over = {}) {
  return {
    id: over.id || 'x',
    title: over.title || '할 일',
    due: 'due' in over ? over.due : null,
    priority: over.priority || 'normal',
    done: over.done === true,
    doneAt: over.doneAt || null,
    createdAt: over.createdAt || '2026-08-01T00:00:00.000Z',
    subtasks: over.subtasks || [],
  };
}

test('addDays는 달을 넘겨도 맞는다', () => {
  assert.equal(F.addDays('2026-08-30', 3), '2026-09-02');
  assert.equal(F.addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(F.addDays(TODAY, 0), TODAY);
});

test('diffDays는 윤년을 넘겨도 맞는다', () => {
  assert.equal(F.diffDays('2028-02-28', '2028-03-01'), 2); // 2028년은 윤년
  assert.equal(F.diffDays('2027-02-28', '2027-03-01'), 1);
  assert.equal(F.diffDays(TODAY, TODAY), 0);
});

test('bucket이 마감일에 따라 갈린다', () => {
  assert.equal(F.bucket(todo({ due: TODAY }), TODAY), 'today');
  assert.equal(F.bucket(todo({ due: '2026-08-23' }), TODAY), 'overdue');
  assert.equal(F.bucket(todo({ due: '2026-08-28' }), TODAY), 'week');
  assert.equal(F.bucket(todo({ due: '2026-08-30' }), TODAY), 'week'); // 6일 뒤까지 이번주
  assert.equal(F.bucket(todo({ due: '2026-08-31' }), TODAY), 'later');
  assert.equal(F.bucket(todo({ due: null }), TODAY), 'someday');
  assert.equal(F.bucket(todo({ due: TODAY, done: true }), TODAY), 'done');
});

test('오늘 보기에는 밀린 일도 함께 뜬다', () => {
  const list = [
    todo({ id: 'a', due: TODAY }),
    todo({ id: 'b', due: '2026-08-20' }),
    todo({ id: 'c', due: '2026-08-27' }),
  ];
  assert.deepEqual(
    F.filterTodos(list, 'today', TODAY).map((t) => t.id),
    ['b', 'a']
  );
});

test('완료한 일은 오늘·이번주·전체에서 빠진다', () => {
  const list = [todo({ id: 'a', due: TODAY, done: true, doneAt: '2026-08-24T01:00:00.000Z' })];
  assert.equal(F.filterTodos(list, 'today', TODAY).length, 0);
  assert.equal(F.filterTodos(list, 'week', TODAY).length, 0);
  assert.equal(F.filterTodos(list, 'all', TODAY).length, 0);
  assert.equal(F.filterTodos(list, 'done', TODAY).length, 1);
});

test('밀린 일이 맨 위, 그다음 마감일 · 우선순위 순', () => {
  const list = [
    todo({ id: 'later', due: '2026-08-29' }),
    todo({ id: 'late', due: '2026-08-10' }),
    todo({ id: 'todayLow', due: TODAY, priority: 'low' }),
    todo({ id: 'todayHigh', due: TODAY, priority: 'high' }),
  ];
  assert.deepEqual(
    F.sortTodos(list, TODAY).map((t) => t.id),
    ['late', 'todayHigh', 'todayLow', 'later']
  );
});

test('마감 없는 일은 전체에는 있지만 이번주에는 없다', () => {
  const list = [todo({ id: 'someday', due: null })];
  assert.equal(F.filterTodos(list, 'all', TODAY).length, 1);
  assert.equal(F.filterTodos(list, 'week', TODAY).length, 0);
  assert.equal(F.filterTodos(list, 'today', TODAY).length, 0);
});

test('dueLabel은 가까운 날짜를 말로 바꾼다', () => {
  assert.equal(F.dueLabel(TODAY, TODAY), '오늘');
  assert.equal(F.dueLabel('2026-08-25', TODAY), '내일');
  assert.equal(F.dueLabel('2026-08-23', TODAY), '어제');
  assert.equal(F.dueLabel('2026-08-21', TODAY), '3일 지남');
  assert.equal(F.dueLabel('2026-08-27', TODAY), '3일 뒤');
  assert.equal(F.dueLabel('2026-09-15', TODAY), '09/15');
  assert.equal(F.dueLabel(null, TODAY), '');
});

test('counts는 탭마다 개수를 센다', () => {
  const list = [
    todo({ id: 'a', due: TODAY }),
    todo({ id: 'b', due: '2026-08-10' }),
    todo({ id: 'c', due: '2026-08-27' }),
    todo({ id: 'd', done: true, doneAt: '2026-08-24T01:00:00.000Z' }),
  ];
  const c = F.counts(list, TODAY);
  assert.equal(c.today, 2);
  assert.equal(c.overdue, 1);
  assert.equal(c.week, 3);
  assert.equal(c.all, 3);
  assert.equal(c.done, 1);
});

test('todayStr은 로컬 날짜를 준다 (UTC로 밀리지 않는다)', () => {
  // 로컬 자정 직후. UTC로 바꾸면 전날이 되는 시각이다.
  const justAfterMidnight = new Date(2026, 7, 24, 0, 30, 0);
  assert.equal(F.todayStr(justAfterMidnight), '2026-08-24');
});

/* ── 알림 시각 ────────────────────────────── */

test('isDateTimeStr은 실제로 있는 시각만 통과시킨다', () => {
  assert.equal(F.isDateTimeStr('2026-09-05T14:00'), true);
  assert.equal(F.isDateTimeStr('2026-09-05T00:00'), true);
  assert.equal(F.isDateTimeStr('2026-09-05T23:59'), true);

  assert.equal(F.isDateTimeStr('2026-09-05'), false);        // 날짜만
  assert.equal(F.isDateTimeStr('2026-09-05T24:00'), false);  // 24시는 없다
  assert.equal(F.isDateTimeStr('2026-09-05T14:60'), false);
  assert.equal(F.isDateTimeStr('2026-13-05T14:00'), false);
  assert.equal(F.isDateTimeStr('2026-02-30T14:00'), false);  // 없는 날
  assert.equal(F.isDateTimeStr('2026-09-05 14:00'), false);  // T가 아니면 안 받는다
  assert.equal(F.isDateTimeStr(null), false);
  assert.equal(F.isDateTimeStr(''), false);
});

test('parseLocalDateTime은 로컬 시각으로 읽는다', () => {
  const d = F.parseLocalDateTime('2026-09-05T14:30');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 14);
  assert.equal(d.getMinutes(), 30);
  assert.equal(F.parseLocalDateTime('엉터리'), null);
});

test('toDateTimeStr과 parseLocalDateTime은 서로를 되돌린다', () => {
  const s = '2026-09-05T14:30';
  assert.equal(F.toDateTimeStr(F.parseLocalDateTime(s)), s);
});

test('remindLabel은 오늘·내일을 사람 말로 쓴다', () => {
  assert.equal(F.remindLabel('2026-08-24T14:00', TODAY), '오늘 14:00');
  assert.equal(F.remindLabel('2026-08-25T09:05', TODAY), '내일 09:05');
  assert.equal(F.remindLabel('2026-08-23T18:00', TODAY), '어제 18:00');
  assert.equal(F.remindLabel('2026-09-05T14:00', TODAY), '9/5 14:00');
  assert.equal(F.remindLabel(null, TODAY), '');
  assert.equal(F.remindLabel('2026-09-05', TODAY), '');
});
