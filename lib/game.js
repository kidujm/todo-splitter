'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 경험치(XP)·레벨 규칙. filters.js처럼 서버와 브라우저가 같은 파일을 쓴다.
 *   - 브라우저: 체크하자마자 '+20 XP'를 바로 띄우려고 (서버 답을 기다리면 느리다)
 *   - 서버: 진짜 장부를 저장하려고. 브라우저가 보낸 XP 숫자는 믿지 않고 서버가 직접 다시 계산한다.
 *
 * 장부(awarded) 방식:
 *   XP를 준 항목마다 { 't:할일id' 또는 's:하위할일id': { xp, on(받은 날짜) } } 한 줄을 남긴다.
 *   - 체크하면 줄을 추가(적립), 체크를 풀면 줄을 지움(회수)
 *   - 끝낸 할일을 목록에서 지워도 줄은 남긴다 (한 번 번 XP는 지켜 준다)
 *   총 XP는 "장부 줄들의 합"이다. 총합을 따로 저장하지 않으니 숫자가 어긋날 일이 없다.
 */

(function () {
// Node에서는 require로, 브라우저에서는 filters.js가 먼저 만들어 둔 window.Filters를 쓴다.
const F = typeof module === 'object' && module.exports ? require('./filters') : window.Filters;

const XP = {
  sub: 10,
  todo: { high: 30, normal: 20, low: 15 },
  onTime: 10, // 마감일 당일이나 그 전에 끝내면 보너스
};

/** 레벨 n에서 n+1로 가는 데 드는 XP: 100, 150, 200 … 갈수록 50씩 늘어난다. */
function needFor(level) {
  return 100 + (level - 1) * 50;
}

// [이 레벨부터, 칭호]
const TITLES = [
  [1, '아기 고양이'],
  [3, '산책 고양이'],
  [5, '사냥 고양이'],
  [8, '대장 고양이'],
  [12, '탐험가 고양이'],
  [16, '보스 고양이'],
  [20, '전설의 고양이'],
];

function titleFor(level) {
  let title = TITLES[0][1];
  for (const [from, name] of TITLES) if (level >= from) title = name;
  return title;
}

/** 총 XP → 지금 레벨, 이번 레벨에서 모은 양(into), 이번 레벨에 필요한 양(need), 칭호. */
function levelInfo(total) {
  let level = 1;
  let rest = Math.max(0, total);
  // 레벨마다 필요한 만큼 빼 나가다가, 다음 레벨 값보다 적게 남으면 거기가 지금 레벨
  while (rest >= needFor(level)) {
    rest -= needFor(level);
    level += 1;
  }
  return { level, into: rest, need: needFor(level), title: titleFor(level) };
}

// XP를 받은 날짜. 끝낸 시각 기록이 없거나 이상하면 오늘로 친다.
function earnedDate(iso) {
  return F.localDateOf(iso) || F.todayStr();
}

/** 할일 하나를 끝냈을 때 받는 XP. bonus는 '마감 전 +10'을 따로 보여 주려고 떼어 둔 값. */
function todoXp(todo) {
  const base = XP.todo[todo.priority] || XP.todo.normal;
  const bonus = todo.due && earnedDate(todo.doneAt) <= todo.due ? XP.onTime : 0;
  return { xp: base + bonus, bonus };
}

/** 지금 체크돼 있는 항목들. 키 모양은 장부와 같다('t:…' / 's:…'). */
function doneItems(todos) {
  const items = new Map();
  for (const todo of todos || []) {
    for (const sub of todo.subtasks || []) {
      if (sub.done) items.set(`s:${sub.id}`, { xp: XP.sub, bonus: 0, doneAt: sub.doneAt });
    }
    if (todo.done) items.set(`t:${todo.id}`, { ...todoXp(todo), doneAt: todo.doneAt });
  }
  return items;
}

/** 목록에 아직 남아 있는 모든 항목의 키 (체크 여부와 상관없이). */
function liveKeys(todos) {
  const keys = new Set();
  for (const todo of todos || []) {
    keys.add(`t:${todo.id}`);
    for (const sub of todo.subtasks || []) keys.add(`s:${sub.id}`);
  }
  return keys;
}

function empty() {
  return { awarded: {} };
}

/** 장부 파일이 없을 때(처음 켤 때) 지금까지 끝낸 기록으로 장부를 만든다. 경험치 기능 전에 한 일도 인정. */
function seed(todos) {
  return apply(empty(), todos).game;
}

/**
 * 목록이 바뀐 뒤 장부를 맞춘다. 장부를 직접 고치지 않고 새 장부를 돌려준다.
 * events: 이번에 적립(+)·회수(-)된 항목. 화면이 '+20 XP'나 레벨업을 띄울 때 쓴다.
 */
function apply(game, todos) {
  const awarded = { ...(game && game.awarded) };
  const done = doneItems(todos);
  const live = liveKeys(todos);
  const events = [];

  // 1) 새로 체크된 것 → 적립
  for (const [key, item] of done) {
    if (awarded[key]) continue;
    awarded[key] = { xp: item.xp, on: earnedDate(item.doneAt) };
    events.push({ key, xp: item.xp, bonus: item.bonus });
  }
  // 2) 목록에 있는데 체크가 풀린 것 → 회수. 목록에서 아예 지워진 항목은 건드리지 않는다.
  for (const key of Object.keys(awarded)) {
    if (live.has(key) && !done.has(key)) {
      events.push({ key, xp: -awarded[key].xp, bonus: 0 });
      delete awarded[key];
    }
  }
  return { game: { awarded }, events };
}

/** 파일에서 읽었거나 밖에서 받은 장부를 믿지 않고 모양을 다시 맞춘다. 이상한 줄은 버린다. */
function normalize(raw) {
  const awarded = {};
  const src = raw && typeof raw === 'object' && raw.awarded && typeof raw.awarded === 'object' ? raw.awarded : {};
  for (const [key, entry] of Object.entries(src)) {
    if (!/^[ts]:/.test(key) || !entry) continue;
    const xp = Number(entry.xp);
    if (!Number.isFinite(xp) || xp <= 0) continue;
    awarded[key] = { xp: Math.round(xp), on: F.isDateStr(entry.on) ? entry.on : F.todayStr() };
  }
  return { awarded };
}

// 장부 줄 중 조건에 맞는 것들의 XP 합
function sumXp(game, keep = () => true) {
  return Object.values((game && game.awarded) || {})
    .filter(keep)
    .reduce((sum, e) => sum + e.xp, 0);
}

function total(game) {
  return sumXp(game);
}

function earnedOn(game, date) {
  return sumXp(game, (e) => e.on === date);
}

const gameApi = { XP, TITLES, needFor, titleFor, levelInfo, todoXp, seed, apply, normalize, total, earnedOn, empty };

// filters.js와 같은 방식으로 Node / 브라우저 양쪽에 내보낸다
if (typeof module === 'object' && module.exports) {
  module.exports = gameApi;
} else if (typeof window !== 'undefined') {
  window.Game = gameApi;
}
})();
