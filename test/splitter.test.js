'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/splitter');
const store = require('../lib/store');

test('깔끔한 JSON 배열을 읽는다', () => {
  assert.deepEqual(S.parseSubtasks('["자료 조사", "초안 작성"]'), ['자료 조사', '초안 작성']);
});

test('코드펜스로 감싼 응답을 읽는다', () => {
  const raw = '```json\n["첫째", "둘째"]\n```';
  assert.deepEqual(S.parseSubtasks(raw), ['첫째', '둘째']);
});

test('앞뒤에 말을 붙여도 배열만 건져낸다', () => {
  const raw = '네, 아래와 같이 나눠봤습니다.\n\n["기획서 뼈대 잡기", "경쟁사 3곳 조사"]\n\n도움이 되었길 바랍니다!';
  assert.deepEqual(S.parseSubtasks(raw), ['기획서 뼈대 잡기', '경쟁사 3곳 조사']);
});

test('객체 배열로 와도 제목을 뽑는다', () => {
  const raw = '[{"title": "자료 조사"}, {"task": "초안"}, {"name": "검토"}]';
  assert.deepEqual(S.parseSubtasks(raw), ['자료 조사', '초안', '검토']);
});

test('JSON이 아니면 목록 줄에서 읽어낸다', () => {
  const raw = ['먼저 이렇게 나눠보세요:', '- 자료 조사하기', '2. 초안 쓰기', '* 검토 요청하기', '', '화이팅!'].join('\n');
  assert.deepEqual(S.parseSubtasks(raw), ['자료 조사하기', '초안 쓰기', '검토 요청하기']);
});

test('마크다운 체크박스 목록도 읽는다', () => {
  const raw = '- [ ] 회의실 예약\n- [x] 안건 정리';
  assert.deepEqual(S.parseSubtasks(raw), ['회의실 예약', '안건 정리']);
});

test('알아볼 수 없으면 빈 배열', () => {
  assert.deepEqual(S.parseSubtasks('죄송하지만 도와드릴 수 없습니다.'), []);
  assert.deepEqual(S.parseSubtasks(''), []);
  assert.deepEqual(S.parseSubtasks(null), []);
});

test('빈 항목은 걸러내고 최대 12개까지만', () => {
  const many = JSON.stringify(Array.from({ length: 30 }, (_, i) => `할일 ${i}`));
  assert.equal(S.parseSubtasks(many).length, 12);
  assert.deepEqual(S.parseSubtasks('["", "  ", "진짜 할일"]'), ['진짜 할일']);
});

test('프롬프트에 제목과 설명이 들어간다', () => {
  const prompt = S.buildPrompt('발표 자료 만들기', '목요일까지');
  assert.match(prompt, /제목: 발표 자료 만들기/);
  assert.match(prompt, /덧붙이는 설명: 목요일까지/);
  assert.match(prompt, /JSON 배열/);

  const bare = S.buildPrompt('발표 자료 만들기', '');
  assert.ok(!bare.includes('덧붙이는 설명'));
});

test('제목이 비면 실행하기 전에 막는다', async () => {
  await assert.rejects(() => S.split({ title: '   ' }), /먼저 적어 주세요/);
});

test('저장 전에 값이 정리된다', () => {
  const [t] = store.normalizeAll([
    { title: '  공백   많은    제목  ', due: '아무거나', priority: '이상함', done: true, subtasks: [{ title: '' }, { title: '하위' }] },
  ]);
  assert.equal(t.title, '공백 많은 제목');
  assert.equal(t.due, null);
  assert.equal(t.priority, 'normal');
  assert.ok(t.id);
  assert.ok(t.doneAt); // done이면 시각이 자동으로 채워진다
  assert.deepEqual(t.subtasks.map((s) => s.title), ['하위']); // 빈 제목은 버린다
});

test('제목 없는 할일은 저장 목록에서 빠진다', () => {
  assert.equal(store.normalizeAll([{ title: '   ' }, { title: '진짜' }]).length, 1);
  assert.deepEqual(store.normalizeAll('배열이 아님'), []);
});

/* ── 알림 시각 저장 ────────────────────────── */

test('remindAt은 올바른 시각 형식만 저장된다', () => {
  const store = require('../lib/store');
  const [ok] = store.normalizeAll([{ title: '할 일', remindAt: '2026-09-05T14:00' }]);
  assert.equal(ok.remindAt, '2026-09-05T14:00');

  const junk = store.normalizeAll([
    { title: 'a', remindAt: '2026-09-05' },
    { title: 'b', remindAt: '내일 두시' },
    { title: 'c', remindAt: '2026-09-05T99:99' },
    { title: 'd' },
  ]);
  assert.deepEqual(junk.map((t) => t.remindAt), [null, null, null, null]);
});

test('remindedAt은 문자열일 때만 남는다', () => {
  const store = require('../lib/store');
  const [a, b] = store.normalizeAll([
    { title: 'a', remindAt: '2026-09-05T14:00', remindedAt: '2026-09-05T05:00:00.000Z' },
    { title: 'b', remindAt: '2026-09-05T14:00', remindedAt: 12345 },
  ]);
  assert.equal(a.remindedAt, '2026-09-05T05:00:00.000Z');
  assert.equal(b.remindedAt, null);
});

test('알림 시각이 없으면 울림 표시도 같이 지워진다', () => {
  const store = require('../lib/store');
  const [t] = store.normalizeAll([{ title: 'a', remindAt: null, remindedAt: '2026-09-05T05:00:00.000Z' }]);
  assert.equal(t.remindAt, null);
  assert.equal(t.remindedAt, null);
});
