'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/game');

const AT = '2026-11-20T03:00:00.000Z'; // 한국 시간 11/20 정오

function todo(over = {}) {
  return { id: 'a', title: '일', priority: 'normal', due: null, done: false, doneAt: null, subtasks: [], ...over };
}

test('우선순위에 따라 XP가 다르다', () => {
  assert.equal(G.todoXp(todo({ priority: 'high' })).xp, 30);
  assert.equal(G.todoXp(todo({ priority: 'normal' })).xp, 20);
  assert.equal(G.todoXp(todo({ priority: 'low' })).xp, 15);
});

test('마감일까지 끝내면 보너스, 넘기면 없다', () => {
  assert.deepEqual(G.todoXp(todo({ due: '2026-11-20', doneAt: AT })), { xp: 30, bonus: 10 });
  assert.deepEqual(G.todoXp(todo({ due: '2026-11-25', doneAt: AT })), { xp: 30, bonus: 10 });
  assert.deepEqual(G.todoXp(todo({ due: '2026-11-19', doneAt: AT })), { xp: 20, bonus: 0 });
});

test('레벨 경계', () => {
  assert.deepEqual(G.levelInfo(0), { level: 1, into: 0, need: 100, title: '아기 고양이' });
  assert.equal(G.levelInfo(99).level, 1);
  assert.equal(G.levelInfo(100).level, 2);
  assert.equal(G.levelInfo(250).level, 3);
  assert.equal(G.levelInfo(249).into, 149);
  assert.equal(G.levelInfo(-5).level, 1);
});

test('체크하면 적립, 풀면 회수', () => {
  const t = todo({ done: true, doneAt: AT });
  const first = G.apply(G.empty(), [t]);
  assert.equal(G.total(first.game), 20);
  assert.deepEqual(first.events, [{ key: 't:a', xp: 20, bonus: 0 }]);

  const again = G.apply(first.game, [t]);
  assert.equal(again.events.length, 0, '이미 받은 XP는 두 번 주지 않는다');

  const undone = G.apply(first.game, [{ ...t, done: false, doneAt: null }]);
  assert.equal(G.total(undone.game), 0);
  assert.deepEqual(undone.events, [{ key: 't:a', xp: -20, bonus: 0 }]);
});

test('끝낸 할일을 지워도 XP는 남는다', () => {
  const t = todo({ done: true, doneAt: AT, subtasks: [{ id: 's1', title: '하위', done: true, doneAt: AT }] });
  const { game } = G.apply(G.empty(), [t]);
  assert.equal(G.total(game), 30);
  const after = G.apply(game, []);
  assert.equal(G.total(after.game), 30);
  assert.equal(after.events.length, 0);
});

test('하위 할일은 10씩, 오늘 번 XP를 따로 센다', () => {
  const t = todo({
    subtasks: [
      { id: 's1', title: '하나', done: true, doneAt: AT },
      { id: 's2', title: '둘', done: true, doneAt: '2026-11-18T03:00:00.000Z' },
    ],
  });
  const game = G.seed([t]);
  assert.equal(G.total(game), 20);
  assert.equal(G.earnedOn(game, '2026-11-20'), 10);
});

test('장부 정리는 이상한 값을 버린다', () => {
  const clean = G.normalize({ awarded: { 't:a': { xp: 20, on: '2026-11-20' }, 'x:b': { xp: 5 }, 't:c': { xp: -3 }, 's:d': { xp: '10' } } });
  assert.deepEqual(Object.keys(clean.awarded).sort(), ['s:d', 't:a']);
  assert.equal(clean.awarded['s:d'].xp, 10);
  assert.deepEqual(G.normalize(null), { awarded: {} });
});
