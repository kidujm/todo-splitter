'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 날짜 계산과 "이 할일은 어느 탭에 들어가나"를 정하는 규칙 모음.
 *
 * 특이한 점: 서버(Node)와 브라우저(화면)가 이 파일 하나를 같이 쓴다.
 *   - 서버는 require('./filters')로 불러 쓰고
 *   - 브라우저는 index.html의 <script src="/filters.js">로 불러 window.Filters로 쓴다.
 * 이렇게 하면 "오늘 탭에 뭐가 들어가나" 같은 규칙이 한 곳에만 있어서,
 * 서버와 화면이 서로 다르게 판단하는 일이 생기지 않는다. (맨 아래 내보내기 부분 참고)
 *
 * 날짜는 Date 객체 대신 로컬 시간 기준 'YYYY-MM-DD' 글자로 들고 다닌다.
 * Date는 내부적으로 UTC(영국 시간)라서, 한국 시간 새벽에 날짜가 하루 어긋나는 버그가 잘 생긴다.
 * 글자로 들고 다니면 그런 일이 없고, 글자끼리 크기 비교('2026-11-20' < '2026-11-21')도 그대로 된다.
 */

// 파일 전체를 (function () { ... })()로 감싼다. 브라우저에서는 <script> 파일들이 이름 공간을 같이 써서,
// 감싸지 않으면 여기 함수 이름(pad, bucket 등)이 app.js의 이름과 부딪칠 수 있다.
(function () {
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 숫자를 두 자리로: 5 → '05'
function pad(n) {
  return String(n).padStart(2, '0');
}

// '2026-11-20' → [2026, 11, 20]
function splitDate(dateStr) {
  return dateStr.split('-').map(Number);
}

// Date 객체 → '2026-11-20' (로컬 시간 기준)
function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr(now = new Date()) {
  return toDateStr(now);
}

// 서버에 저장된 ISO 시각('2026-11-20T03:12:00.000Z') → 로컬 날짜 '2026-11-20'. 값이 이상하면 null.
function localDateOf(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : toDateStr(d);
}

// 'YYYY-MM-DD' 모양인지만 본다
function isDateStr(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

// '2026-11-20' → '금'
function weekdayOf(dateStr) {
  const [y, m, d] = splitDate(dateStr);
  return WEEKDAYS[new Date(y, m - 1, d).getDay()];
}

// 날짜에 n일 더하기. new Date(2026, 10, 31)처럼 넘치는 날짜를 주면 JS가 알아서 다음 달로 넘겨 준다.
function addDays(dateStr, n) {
  const [y, m, d] = splitDate(dateStr);
  return toDateStr(new Date(y, m - 1, d + n));
}

/** b - a (며칠 차이). 서머타임이 있는 나라에서도 하루가 23·25시간으로 틀어지지 않게 UTC로 계산한다. */
function diffDays(a, b) {
  const [y1, m1, d1] = splitDate(a);
  const [y2, m2, d2] = splitDate(b);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

/*
 * ── 탭 분류 ───────────────────────────────────
 * bucket(칸): 할일 하나가 어디에 속하는지 딱 하나로 정한다.
 *   done(끝남) / someday(마감 없음) / overdue(지남) / today / week(6일 안) / later(그 뒤)
 * 탭(view)은 이 칸 여러 개를 묶어 보여 준다. 예: '오늘' 탭 = today + overdue
 */
function bucket(todo, today) {
  if (todo.done) return 'done';
  if (!isDateStr(todo.due)) return 'someday';
  const gap = diffDays(today, todo.due);
  if (gap < 0) return 'overdue';
  if (gap === 0) return 'today';
  if (gap <= 6) return 'week';
  return 'later';
}

const VIEWS = ['today', 'week', 'overdue', 'all', 'done'];

// 탭마다 어떤 칸을 보여 주는지. 'all'은 끝난 것 빼고 전부.
const VIEW_BUCKETS = {
  today: ['today', 'overdue'],
  week: ['today', 'overdue', 'week'],
  overdue: ['overdue'],
  done: ['done'],
  all: ['overdue', 'today', 'week', 'later', 'someday'],
};

function inView(b, view) {
  return (VIEW_BUCKETS[view] || VIEW_BUCKETS.all).includes(b);
}

function matchesView(todo, view, today) {
  return inView(bucket(todo, today), view);
}

const BUCKET_RANK = { overdue: 0, today: 1, week: 2, later: 3, someday: 4, done: 5 };
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

/**
 * 급한 것이 위로 오게 정렬: 지난 마감 → 오늘 → 마감일 빠른 순 → 우선순위 → 먼저 만든 순.
 * 정렬은 두 개씩 비교를 수없이 반복한다. 비교할 때마다 날짜를 다시 계산하면 낭비라서
 * 칸(bucket)을 먼저 한 번씩만 계산해 Map에 담아 두고 꺼내 쓴다.
 */
function sortTodos(list, today) {
  const rankOf = new Map(list.map((t) => [t, BUCKET_RANK[bucket(t, today)]]));
  return [...list].sort((a, b) => {
    const diff = rankOf.get(a) - rankOf.get(b);
    if (diff) return diff;

    // 완료 목록은 최근에 끝낸 것부터
    if (a.done && b.done) return String(b.doneAt || '').localeCompare(String(a.doneAt || ''));
    if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);

    const pa = PRIORITY_RANK[a.priority] ?? 1;
    const pb = PRIORITY_RANK[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;

    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

// 화면에 실제로 그릴 목록: 탭에 맞는 것만 골라 정렬
function filterTodos(todos, view, today) {
  return sortTodos(todos.filter((t) => matchesView(t, view, today)), today);
}

// 탭 옆 숫자. 할일마다 칸을 한 번만 계산하고, 그 칸이 들어가는 탭들의 숫자를 올린다.
function counts(todos, today) {
  const out = Object.fromEntries(VIEWS.map((v) => [v, 0]));
  for (const todo of todos) {
    const b = bucket(todo, today);
    for (const view of VIEWS) if (inView(b, view)) out[view] += 1;
  }
  return out;
}

/** 마감일 배지 글자: '오늘', '내일', '3일 지남', '5일 뒤', 먼 날은 '12/25' */
function dueLabel(due, today) {
  if (!isDateStr(due)) return '';
  const gap = diffDays(today, due);
  if (gap === 0) return '오늘';
  if (gap === 1) return '내일';
  if (gap === -1) return '어제';
  if (gap < 0) return `${-gap}일 지남`;
  if (gap <= 6) return `${gap}일 뒤`;
  return due.slice(5).replace('-', '/');
}

/*
 * ── 알림 시각 ─────────────────────────────────
 * 마감일과 같은 이유로, 알림 시각도 로컬 'YYYY-MM-DDTHH:mm' 글자로만 다룬다.
 * UTC로 바꿔 저장하면 PC 시간대가 바뀌었을 때 알림이 조용히 몇 시간씩 어긋난다.
 */

/** 'YYYY-MM-DDTHH:mm' 글자를 Date로. 모양이 틀리거나 없는 날짜(2월 30일 등)면 null. */
function parseLocalDateTime(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const [date, time] = v.split('T');
  const [y, m, d] = splitDate(date);
  const [hh, mm] = time.split(':').map(Number);
  if (hh > 23 || mm > 59) return null;
  const at = new Date(y, m - 1, d, hh, mm, 0, 0);
  // JS는 2월 30일을 주면 3월 2일로 바꿔 버린다. 바뀌었으면 없는 날짜였다는 뜻.
  if (at.getFullYear() !== y || at.getMonth() !== m - 1 || at.getDate() !== d) return null;
  return at;
}

function isDateTimeStr(v) {
  return parseLocalDateTime(v) !== null;
}

// Date → '2026-11-20T14:05'
function toDateTimeStr(d) {
  return `${toDateStr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 알림 배지 글자: '오늘 14:00', '내일 09:00', 그 밖엔 '11/25 14:00' */
function remindLabel(remindAt, today) {
  if (!isDateTimeStr(remindAt)) return '';
  const [date, time] = remindAt.split('T');
  const gap = diffDays(today, date);
  if (gap === 0) return `오늘 ${time}`;
  if (gap === 1) return `내일 ${time}`;
  if (gap === -1) return `어제 ${time}`;
  const [, m, d] = splitDate(date);
  return `${m}/${d} ${time}`;
}

const filtersApi = {
  WEEKDAYS,
  toDateStr,
  todayStr,
  localDateOf,
  isDateStr,
  weekdayOf,
  addDays,
  diffDays,
  bucket,
  matchesView,
  sortTodos,
  filterTodos,
  counts,
  dueLabel,
  isDateTimeStr,
  toDateTimeStr,
  parseLocalDateTime,
  remindLabel,
  VIEWS,
};

/*
 * ── 내보내기 ───────────────────────────────────
 * Node에는 module.exports가 있고 브라우저에는 없다. 그걸로 어디서 돌고 있는지 알아낸다.
 *   Node      → module.exports에 담아 require()로 꺼내 쓰게 한다
 *   브라우저  → window.Filters에 담아 app.js가 꺼내 쓰게 한다
 */
if (typeof module === 'object' && module.exports) {
  module.exports = filtersApi;
} else if (typeof window !== 'undefined') {
  window.Filters = filtersApi;
}
})();
