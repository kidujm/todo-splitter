'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 할일 목록과 XP 장부를 파일로 읽고 쓴다. DB 없이 JSON 파일 두 개가 전부다.
 *   data/todos.json      할일 목록 (저장 직전 상태는 todos.bak.json에 백업)
 *   data/game.json       XP 장부
 *
 * 핵심 원칙: 화면(브라우저)이 보낸 값은 그대로 믿지 않는다.
 * 저장하기 전에 normalize()로 모양을 맞추고, 글자 수를 자르고, 이상한 값은 기본값으로 바꾼다.
 * 그래야 화면 쪽 버그나 엉뚱한 요청이 와도 파일이 망가지지 않는다.
 */

const fs = require('node:fs');
const path = require('node:path');
const { isDateStr, isDateTimeStr } = require('./filters');
const game = require('./game');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'todos.json');
const BAK = path.join(DATA_DIR, 'todos.bak.json');
const GAME_FILE = path.join(DATA_DIR, 'game.json');

const PRIORITIES = ['high', 'normal', 'low'];

// 겹치지 않는 id: 지금 시각(36진수) + 무작위 6글자. 예: 'mt6pjgtb-069ie2'
function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 줄바꿈·연속 공백을 한 칸으로 합치고 최대 길이로 자른다 (제목용)
function clean(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// 끝났으면 끝난 시각을 지키고(없으면 지금), 안 끝났으면 null
function doneAtOf(item, done) {
  if (!done) return null;
  return typeof item.doneAt === 'string' ? item.doneAt : new Date().toISOString();
}

function idOf(item) {
  return typeof item.id === 'string' && item.id ? item.id : newId();
}

function normalizeSubtask(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const done = s.done === true;
  return { id: idOf(s), title: clean(s.title, 200), done, doneAt: doneAtOf(s, done) };
}

/** 할일 하나의 모양을 맞춘다. 저장되는 모든 할일은 반드시 여기를 지나간다. */
function normalize(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const done = t.done === true;
  const remindAt = isDateTimeStr(t.remindAt) ? t.remindAt : null;
  const subtasks = Array.isArray(t.subtasks)
    ? t.subtasks.map(normalizeSubtask).filter((s) => s.title).slice(0, 50)
    : [];

  return {
    id: idOf(t),
    title: clean(t.title, 300),
    note: String(t.note ?? '').trim().slice(0, 2000), // 메모는 줄바꿈을 살려야 해서 clean()을 안 쓴다
    due: isDateStr(t.due) ? t.due : null,
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'normal',
    done,
    doneAt: doneAtOf(t, done),
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
    remindAt,
    // 알림 시각이 없으면 '울렸음' 표시도 의미가 없다. 같이 비운다.
    remindedAt: remindAt && typeof t.remindedAt === 'string' ? t.remindedAt : null,
    subtasks,
  };
}

// 목록 전체: 각각 정리하고, 제목 없는 건 버리고, 1000개까지만
function normalizeAll(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalize).filter((t) => t.title).slice(0, 1000);
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function load() {
  ensureDir();
  if (!fs.existsSync(FILE)) return [];
  try {
    return normalizeAll(readJson(FILE));
  } catch (err) {
    // 본 파일이 깨졌으면 직전 백업으로 한 번 더 시도한다
    if (fs.existsSync(BAK)) {
      try {
        return normalizeAll(readJson(BAK));
      } catch {
        /* 백업도 못 읽으면 아래 오류로 */
      }
    }
    throw new Error(`todos.json을 읽을 수 없습니다: ${err.message}`);
  }
}

/*
 * 원자적 저장: 임시 파일에 다 쓴 다음 이름을 바꿔 끼운다.
 * 본 파일에 바로 쓰다가 전원이 꺼지면 반쯤 쓴 깨진 파일이 남는다.
 * 이름 바꾸기(rename)는 한 번에 일어나서, 파일은 "예전 것" 아니면 "새 것" 둘 중 하나로만 남는다.
 */
function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function save(list) {
  ensureDir();
  const todos = normalizeAll(list);
  if (fs.existsSync(FILE)) fs.copyFileSync(FILE, BAK); // 덮어쓰기 전 상태를 백업
  writeAtomic(FILE, todos);
  return todos;
}

/** XP 장부 읽기. 파일이 없거나 깨졌으면 지금까지 끝낸 기록으로 새로 만든다. */
function loadGame(todos) {
  ensureDir();
  if (fs.existsSync(GAME_FILE)) {
    try {
      return game.normalize(readJson(GAME_FILE));
    } catch {
      /* 깨졌으면 아래에서 다시 만든다 */
    }
  }
  const seeded = game.seed(todos);
  writeAtomic(GAME_FILE, seeded);
  return seeded;
}

function saveGame(data) {
  ensureDir();
  const tidy = game.normalize(data);
  writeAtomic(GAME_FILE, tidy);
  return tidy;
}

module.exports = { load, save, loadGame, saveGame, normalize, normalizeAll, newId, FILE, GAME_FILE, DATA_DIR, PRIORITIES };
