'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * [업무일지로] 버튼. 오늘 끝낸 일을 마크다운으로 정리하고,
 * 원하면 Documents\WorkLog\Daily\{날짜}.md 파일의 해당 칸 아래에 끼워 넣는다.
 *
 * 정리 순서: collectDay(오늘 것만 골라 담기) → doneLines / progressLines(줄로 바꾸기)
 *            → buildMarkdown(미리보기용) 또는 mergeIntoDaily(기존 노트에 끼워 넣기)
 * 기존 노트에 사용자가 적어 둔 내용은 절대 지우지 않는다. 비어 있는 '- [ ]' 껍데기만 정리한다.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { localDateOf, isDateStr, dueLabel, weekdayOf } = require('./filters');

const DAILY_DIR = path.join(os.homedir(), 'Documents', 'WorkLog', 'Daily');

function ratio(todo) {
  const subs = todo.subtasks || [];
  if (!subs.length) return '';
  return `${subs.filter((s) => s.done).length}/${subs.length}`;
}

/** 그날 하루치 성과를 끝낸 일 / 진행 중으로 갈라 담는다. */
function collectDay(todos, dateStr) {
  const done = [];
  const progress = [];

  for (const t of todos) {
    const subs = t.subtasks || [];
    const subsDoneToday = subs.filter((s) => s.done && localDateOf(s.doneAt) === dateStr);

    if (t.done && localDateOf(t.doneAt) === dateStr) {
      done.push({ title: t.title, subs: subsDoneToday.map((s) => s.title) });
      continue;
    }
    if (!t.done && subsDoneToday.length) {
      progress.push({
        title: t.title,
        ratio: ratio(t),
        due: isDateStr(t.due) ? t.due : null,
        subs: subsDoneToday.map((s) => s.title),
      });
    }
  }

  return { date: dateStr, done, progress };
}

function doneLines(day) {
  const out = [];
  for (const item of day.done) {
    out.push(`- [x] ${item.title}`);
    for (const s of item.subs) out.push(`\t- [x] ${s}`);
  }
  return out;
}

function progressLines(day) {
  const out = [];
  for (const item of day.progress) {
    const tail = [item.ratio, item.due ? `마감 ${dueLabel(item.due, day.date)}` : ''].filter(Boolean).join(' · ');
    out.push(`- [ ] ${item.title}${tail ? ` (${tail})` : ''}`);
    for (const s of item.subs) out.push(`\t- [x] ${s}`);
  }
  return out;
}

/** 미리보기 창에 띄우고 클립보드로도 복사할 마크다운. */
function buildMarkdown(todos, dateStr) {
  const day = collectDay(todos, dateStr);
  const dn = doneLines(day);
  const pg = progressLines(day);

  const out = [`## ✅ 오늘 한 일`];
  out.push(...(dn.length ? dn : ['- (없음)']));
  out.push('', `## 🔄 진행 중 · 대기`);
  out.push(...(pg.length ? pg : ['- (없음)']));

  return out.join('\n');
}

function dailyPath(dateStr, dir = DAILY_DIR) {
  return path.join(dir, `${dateStr}.md`);
}

/** 빈 껍데기 체크박스만 골라낸다. 사용자가 적어둔 내용은 건드리지 않는다. */
function isBlankItem(line) {
  return /^\s*-\s*(\[\s*\])?\s*$/.test(line);
}

/**
 * 데일리 노트의 해당 섹션 바로 아래에 줄을 끼워 넣는다.
 * 섹션이 없으면 문서 끝에 새로 만든다. 원래 내용은 지우지 않는다.
 */
function insertUnderHeading(lines, headingMatcher, newLines) {
  if (!newLines.length) return lines;

  const idx = lines.findIndex((l) => /^##\s/.test(l) && headingMatcher.test(l));
  if (idx === -1) {
    return [...lines, '', ...newLines];
  }

  // 안내용 주석(<!-- -->) 줄은 건너뛰고 그 아래에 넣는다.
  let at = idx + 1;
  while (at < lines.length && /^\s*<!--/.test(lines[at])) at += 1;

  // 이 섹션이 끝나는 지점
  let end = at;
  while (end < lines.length && !/^##\s/.test(lines[end])) end += 1;

  const body = lines.slice(at, end).filter((l) => !isBlankItem(l));
  return [...lines.slice(0, at), ...newLines, ...body, ...lines.slice(end)];
}

// 새 노트를 만들 때 맨 위에 들어갈 머리말 (--- 사이는 노트 앱이 읽는 정보 칸)
function frontMatter(dateStr) {
  return ['---', `date: ${dateStr}`, 'tags: [daily]', '---', '', `# 📅 ${dateStr} (${weekdayOf(dateStr)})`, ''];
}

function mergeIntoDaily(existing, day) {
  const base = existing ? existing.replace(/\r\n/g, '\n').split('\n') : frontMatter(day.date);
  let lines = insertUnderHeading(base, /오늘 한 일/, doneLines(day));
  lines = insertUnderHeading(lines, /진행 중/, progressLines(day));
  return lines.join('\n');
}

/** 데일리 노트에 실제로 기록한다. 파일이 없으면 새로 만든다. */
function saveToDaily(todos, dateStr, dir = DAILY_DIR) {
  const day = collectDay(todos, dateStr);
  if (!day.done.length && !day.progress.length) {
    throw new Error('오늘 완료한 항목이 없어서 기록할 내용이 없습니다.');
  }

  const file = dailyPath(dateStr, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existed = fs.existsSync(file);
  const existing = existed ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, mergeIntoDaily(existing, day), 'utf8');

  return { file, created: !existed, done: day.done.length, progress: day.progress.length };
}

module.exports = {
  localDateOf,
  collectDay,
  buildMarkdown,
  mergeIntoDaily,
  insertUnderHeading,
  saveToDaily,
  dailyPath,
  DAILY_DIR,
};
