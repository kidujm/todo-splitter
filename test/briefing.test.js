'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../tools/briefing');

const todo = (over) => ({ title: '일', note: '', due: null, done: false, subtasks: [], ...over });

test('브리핑 글은 \n으로 잇고, 윈도우 글상자에 넣을 때만 \r\n으로 바꾼다', () => {
  const text = B.buildText([todo({ title: '보고서', due: '2026-11-20' }), todo({ title: '회의', due: '2026-11-21' })], '2026-11-20');
  assert.ok(text.includes('\n') && !text.includes('\r'));
  assert.ok(B.windowScript(text).includes('\r\n'));
});

test('보여 줄 할일이 없으면 null', () => {
  assert.equal(B.buildText([todo({ done: true, due: '2026-11-20' })], '2026-11-20'), null);
});

test('맥 브리핑 스크립트는 본문과 주소를 argv로 받는다', () => {
  const s = B.MAC_SCRIPT.join('\n');
  assert.ok(s.includes('item 1 of argv') && s.includes('open location (item 2 of argv)'));
});
