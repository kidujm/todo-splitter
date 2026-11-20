'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../lib/worklog');

const TODAY = '2026-08-24';
const YESTERDAY = '2026-08-23';

/** 그날 정오의 ISO 시각. 시간대가 달라도 날짜가 밀리지 않는다. */
function at(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

test('오늘 끝낸 일만 골라낸다', () => {
  const todos = [
    { title: '오늘 끝낸 일', done: true, doneAt: at(TODAY), subtasks: [] },
    { title: '어제 끝낸 일', done: true, doneAt: at(YESTERDAY), subtasks: [] },
    { title: '아직 안 끝난 일', done: false, doneAt: null, subtasks: [] },
  ];
  const day = W.collectDay(todos, TODAY);
  assert.deepEqual(day.done.map((d) => d.title), ['오늘 끝낸 일']);
  assert.equal(day.progress.length, 0);
});

test('하위만 끝낸 일은 진행 중으로 잡힌다', () => {
  const todos = [
    {
      title: '블로그 글쓰기',
      done: false,
      doneAt: null,
      due: '2026-08-26',
      subtasks: [
        { title: '자료 모으기', done: true, doneAt: at(TODAY) },
        { title: '초안 쓰기', done: true, doneAt: at(YESTERDAY) },
        { title: '퇴고', done: false, doneAt: null },
      ],
    },
  ];
  const day = W.collectDay(todos, TODAY);
  assert.equal(day.done.length, 0);
  assert.equal(day.progress.length, 1);
  assert.equal(day.progress[0].ratio, '2/3');
  assert.deepEqual(day.progress[0].subs, ['자료 모으기']); // 오늘 끝낸 것만
});

test('마크다운에 체크박스 형식으로 나온다', () => {
  const todos = [{ title: '보고서 제출', done: true, doneAt: at(TODAY), subtasks: [] }];
  const md = W.buildMarkdown(todos, TODAY);
  assert.match(md, /## ✅ 오늘 한 일/);
  assert.match(md, /- \[x\] 보고서 제출/);
  assert.match(md, /## 🔄 진행 중 · 대기/);
});

test('빈 날은 (없음)으로 표시한다', () => {
  const md = W.buildMarkdown([], TODAY);
  assert.match(md, /- \(없음\)/);
});

test('데일리 노트의 기존 내용을 지우지 않는다', () => {
  const existing = [
    '---',
    'date: 2026-08-24',
    '---',
    '',
    '## ✅ 오늘 한 일',
    '<!-- 안내문 -->',
    '- [ ] ',
    '- [x] 직접 적어둔 일',
    '',
    '## 📞 미팅 · 연락',
    '- 김대리와 통화',
  ].join('\n');

  const day = W.collectDay([{ title: '새로 넣을 일', done: true, doneAt: at(TODAY), subtasks: [] }], TODAY);
  const merged = W.mergeIntoDaily(existing, day);

  assert.match(merged, /- \[x\] 새로 넣을 일/);
  assert.match(merged, /- \[x\] 직접 적어둔 일/); // 원래 내용 보존
  assert.match(merged, /- 김대리와 통화/); // 다른 섹션도 보존
  assert.match(merged, /<!-- 안내문 -->/); // 안내 주석 위로 끼어들지 않는다
  assert.ok(!merged.includes('\n- [ ] \n')); // 빈 껍데기 체크박스는 정리
});

test('섹션이 없는 노트에는 끝에 덧붙인다', () => {
  const day = W.collectDay([{ title: '메모만 있던 날', done: true, doneAt: at(TODAY), subtasks: [] }], TODAY);
  const merged = W.mergeIntoDaily('# 아무 형식 없는 노트\n', day);
  assert.match(merged, /# 아무 형식 없는 노트/);
  assert.match(merged, /- \[x\] 메모만 있던 날/);
});

test('노트가 없으면 새로 만들고, 있으면 이어 쓴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoapp-'));
  try {
    const todos = [{ title: '첫 기록', done: true, doneAt: at(TODAY), subtasks: [] }];
    const first = W.saveToDaily(todos, TODAY, dir);
    assert.equal(first.created, true);
    assert.equal(first.done, 1);

    const second = W.saveToDaily(todos, TODAY, dir);
    assert.equal(second.created, false);

    const text = fs.readFileSync(W.dailyPath(TODAY, dir), 'utf8');
    assert.match(text, /date: 2026-08-24/);
    assert.equal(text.split('- [x] 첫 기록').length - 1, 2); // 두 번 기록하면 두 줄
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('기록할 게 없으면 파일을 건드리지 않고 알려준다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todoapp-'));
  try {
    assert.throws(() => W.saveToDaily([], TODAY, dir), /기록할 내용이 없습니다/);
    assert.equal(fs.existsSync(W.dailyPath(TODAY, dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doneAt이 망가진 값이어도 죽지 않는다', () => {
  const todos = [{ title: '이상한 값', done: true, doneAt: 'not-a-date', subtasks: [] }];
  assert.equal(W.localDateOf('not-a-date'), null);
  assert.equal(W.collectDay(todos, TODAY).done.length, 0);
});
