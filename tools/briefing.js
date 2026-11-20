'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 아침 브리핑 창: 오늘 마감인 할일, 밀린 할일, 다음 일정 4개를 창 하나로 보여 준다.
 *
 * 서버와 따로 도는 작은 프로그램이다. 작업 스케줄러가 매일 09:00과 로그온 때
 * briefing.vbs(검은 창 없이 실행해 주는 껍데기)를 통해 이 파일을 실행한다.
 * 하루에 한 번만 띄운다. 바로 다시 보려면: node tools/briefing.js --force
 */

const fs = require('node:fs');
const path = require('node:path');

const store = require('../lib/store');
const F = require('../lib/filters');
const popup = require('../lib/popup');

const LAST_FILE = path.join(store.DATA_DIR, 'briefing-last.txt'); // 마지막으로 띄운 날짜
const LOG_FILE = path.join(store.DATA_DIR, 'briefing.log');
const APP_URL = 'http://127.0.0.1:4321';
const UPCOMING = 4;
const MAX_TEXT = 3000;

// '2026-11-20' → '11/20(금)'
function dayLabel(dateStr) {
  const [, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}(${F.weekdayOf(dateStr)})`;
}

const byDue = (a, b) => a.due.localeCompare(b.due);

// 할일 한 줄 + 메모 + 아직 안 끝낸 하위 할일
function detail(todo, prefix) {
  const lines = [`${prefix}${todo.title}`];
  if (todo.note) lines.push(`  메모: ${todo.note}`);
  for (const s of todo.subtasks) if (!s.done) lines.push(`  - ${s.title}`);
  return lines;
}

/** 창에 넣을 글. 보여 줄 게 하나도 없으면 null. 날짜가 글자라 '<', '>'로 바로 비교된다. */
function buildText(todos, today) {
  const open = todos.filter((t) => !t.done && t.due);
  const due = open.filter((t) => t.due === today);
  const overdue = open.filter((t) => t.due < today).sort(byDue);
  const upcoming = open.filter((t) => t.due > today).sort(byDue).slice(0, UPCOMING);
  if (!due.length && !overdue.length && !upcoming.length) return null;

  const out = [`오늘 ${dayLabel(today)}`];
  if (due.length) due.forEach((t) => out.push(...detail(t, '')));
  else out.push('오늘 기한인 일은 없어요');

  if (overdue.length) {
    out.push('', '밀린 일');
    overdue.forEach((t) => out.push(...detail(t, `${dayLabel(t.due)} `)));
  }
  if (upcoming.length) {
    out.push('', '다음 일정');
    upcoming.forEach((t) => out.push(`${dayLabel(t.due)} ${t.title}`));
  }
  return out.join('\r\n').slice(0, MAX_TEXT); // 윈도우 글상자는 줄바꿈으로 \r\n을 쓴다
}

/** 브리핑 창: 제목, 스크롤되는 글상자, [할일 앱 열기] [확인]. 부품은 popup.js의 ps를 쓴다. */
function windowScript(text) {
  const { ps, psQuote, INK, LEMON, CREAM } = popup;
  return [
    ...ps.form('할일 쪼개기 아침 브리핑', 580, 560),
    ...ps.label('head', '오늘 꼭 해야 합니다', { color: LEMON, size: 15, bold: true, box: [24, 18, 520, 36] }),

    // 글이 길 수 있어서 라벨 대신 읽기 전용 글상자(스크롤 가능)를 쓴다
    '$box = New-Object System.Windows.Forms.TextBox',
    '$box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = "Vertical"',
    '$box.BorderStyle = "None"',
    `$box.BackColor = ${ps.color(INK)}`,
    `$box.ForeColor = ${ps.color(CREAM)}`,
    `$box.Font = ${ps.font(11)}`,
    ...ps.place('box', [24, 64, 520, 380]),
    `$box.Text = ${psQuote(text)}`,
    '$f.Controls.Add($box)',

    ...ps.button('open', '할일 앱 열기', [318, 460, 120, 36], [`$open.Add_Click({ Start-Process ${psQuote(APP_URL)}; $f.Close() })`]),
    ...ps.button('ok', '확인', [446, 460, 98, 36], ['$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK']),
    '$f.AcceptButton = $ok',

    // 백그라운드에서 띄운 창은 포커스를 못 가져가서, 맨 위 고정을 풀면 다른 창 뒤로 숨는다
    '$f.Add_Shown({ $f.Activate(); $ok.Focus() })',
    '[void]$f.ShowDialog()',
  ].join('\n');
}

function main() {
  const force = process.argv.includes('--force');
  const today = F.todayStr();
  // 오늘 이미 띄웠으면 끝
  if (!force && fs.existsSync(LAST_FILE) && fs.readFileSync(LAST_FILE, 'utf8').trim() === today) return;

  const text = buildText(store.load(), today);
  // 로그온과 09:00이 겹쳐도 두 번 뜨지 않게, 띄우기 '전에' 날짜부터 적어 둔다
  fs.writeFileSync(LAST_FILE, today, 'utf8');
  if (!text) return;

  // 창이 닫힐 때까지 기다린다. 먼저 끝나 버리면 작업 스케줄러가 남은 창까지 같이 닫는다.
  // windowsHide는 쓰지 않는다: 숨김 시작 값을 물려받아 창까지 안 보이게 된다.
  // node가 이미 숨은 콘솔(briefing.vbs)에서 돌기 때문에 PowerShell 콘솔도 보이지 않는다.
  const err = fs.openSync(LOG_FILE, 'w');
  const child = popup.runPowerShell(windowScript(text), { stdio: ['ignore', 'ignore', err] });
  child.on('exit', (code) => fs.appendFileSync(LOG_FILE, `\nexit ${code} ${new Date().toISOString()}\n`));
}

// 직접 실행했을 때만 main()을 돈다. 테스트에서 require로 불러올 때는 창을 띄우지 않는다.
if (require.main === module) main();

module.exports = { buildText, dayLabel, windowScript };
