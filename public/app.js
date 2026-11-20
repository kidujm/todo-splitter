'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 브라우저 화면의 모든 동작. 버튼 클릭, 목록 그리기, 창(모달) 열고 닫기, 서버와 주고받기.
 *
 * 화면이 돌아가는 기본 원리 (이 파일 전체가 이 순서를 따른다):
 *   1) state(상태) 객체에 지금 데이터를 들고 있는다. 할일 목록, 보고 있는 탭 등.
 *   2) 사용자가 뭔가 하면 state를 고친다.
 *   3) render()가 state를 보고 화면을 처음부터 다시 그린다.
 *   4) persist()가 바뀐 목록을 서버에 보내 파일에 저장한다.
 * 화면 일부만 골라 고치는 대신 매번 다시 그리면, 화면과 데이터가 어긋날 일이 없다.
 *
 * 앞에서 불러온 공용 규칙: F = filters.js(날짜·탭), G = game.js(XP·레벨). index.html이 먼저 불러 둔다.
 *
 * 보안 메모: 사용자가 쓴 글은 innerHTML이 아니라 textContent로만 화면에 넣는다.
 * innerHTML로 넣으면 제목에 <script> 같은 걸 적었을 때 그게 코드로 실행될 수 있다(XSS).
 */

const F = window.Filters;
const G = window.Game;

/* ── 마스코트 스프라이트 ───────────────────
   한 글자가 1픽셀이다. b = 선, w = 몸, p = 볼, '.' = 빈칸.
   고양이를 바꾸고 싶으면 여기 그림만 고치면 된다. */
const CAT = {
  w: 16,
  h: 13,
  rows: [
    '..bb........bb..',
    '.bwwb......bwwb.',
    '.bwwwbbbbbbwwwb.',
    'bwwwwwwwwwwwwwwb',
    'bwwbbwwwwwwbbwwb',
    'bwwbbwwwwwwbbwwb',
    'bwwwwwwwwwwwwwwb',
    'bwpwwwwbbwwwwpwb',
    'bwwwwwbwwbwwwwwb',
    'bwwwwwwbbwwwwwwb',
    '.bwwwwwwwwwwwwb.',
    '..bbwwwwwwwwbb..',
    '....bbbbbbbb....',
  ],
  palette: { b: '#2d2a3e', w: '#fff5e4', p: '#ff8fab' },
};

const SVG_NS = 'http://www.w3.org/2000/svg';

// 위 글자 그림을 SVG(1×1 네모 여러 개)로 바꾼다. crispEdges = 픽셀 경계를 흐리게 하지 말 것.
function spriteSvg(def) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${def.w} ${def.h}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  def.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const fill = def.palette[ch];
      if (!fill) return;
      const rect = document.createElementNS(SVG_NS, 'rect');
      for (const [k, v] of Object.entries({ x, y, width: 1, height: 1, fill })) rect.setAttribute(k, v);
      svg.appendChild(rect);
    });
  });
  return svg;
}

/* ── 상태 ────────────────────────────────── */

const state = {
  todos: [],
  view: 'today', // 지금 보고 있는 탭
  today: F.todayStr(),
  claudeReady: true,
  // 창(모달)이 지금 어떤 할일을 다루고 있는지
  splitTargetId: null,
  remindTargetId: null,
  memoTargetId: null,
  game: G.empty(),
};

// 자주 쓰는 짧은 도우미들
const $ = (id) => document.getElementById(id);
const findTodo = (id) => state.todos.find((t) => t.id === id);
// 서버의 store.newId와 같은 모양의 id
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// 창 안의 빨간 오류 칸. 메시지를 주면 보이고, 빈 값이면 숨긴다.
function showError(boxId, message) {
  const box = $(boxId);
  box.textContent = message || '';
  box.hidden = !message;
}

/* ── 서버 통신 ───────────────────────────── */

// fetch로 서버 API를 부르고 JSON 답을 받는다. 서버가 오류를 주면 그 메시지로 에러를 던진다.
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '서버와 통신하지 못했습니다.');
  return data;
}

let saving = null;
let pendingSave = false;

/**
 * 지금 목록을 서버에 저장한다.
 * 체크를 빠르게 여러 번 누르면 저장 요청이 겹친다. 겹친 요청이 순서가 뒤바뀌어 도착하면
 * 옛날 목록이 마지막에 저장될 수 있다. 그래서 한 번에 하나만 보내고, 보내는 동안 또 바뀌면
 * pendingSave로 표시해 뒀다가 끝나자마자 최신 상태로 한 번 더 보낸다.
 */
async function persist() {
  if (saving) {
    pendingSave = true;
    return saving;
  }
  saving = (async () => {
    try {
      let data;
      do {
        pendingSave = false;
        data = await api('PUT', '/api/todos', { todos: state.todos });
      } while (pendingSave);
      // XP는 서버 장부가 정답이다. 마지막 저장까지 끝난 뒤에만 받아 적는다.
      if (data.game) {
        state.game = data.game;
        paintXp();
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      saving = null;
    }
  })();
  return saving;
}

// 데이터를 바꾼 뒤 늘 하는 두 가지: 저장하고 다시 그리기
function commit() {
  persist();
  render();
}

/* ── 소리 · 알림 ─────────────────────────── */

let soundOn = localStorage.getItem('todoSound') !== 'off'; // localStorage: 브라우저에 남는 작은 저장 공간
let audioCtx = null;

// 8비트 게임 같은 '삑' 소리. 사각파(square)를 짧게 울리고 점점 줄인다.
function blip(freq, dur = 0.07) {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.value = 0.035;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    osc.stop(audioCtx.currentTime + dur);
  } catch {
    /* 소리는 없어도 그만이다 */
  }
}

// 화면 아래에 잠깐 뜨는 안내 문구. 경고는 조금 더 오래 보여 준다.
let toastTimer = null;
function toast(message, isWarning = false) {
  const box = $('toast');
  box.textContent = message;
  box.classList.toggle('warn', isWarning);
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, isWarning ? 4500 : 2200);
}

function fanfare() {
  [523, 659, 784, 1046].forEach((freq, i) => setTimeout(() => blip(freq, 0.12), i * 110)); // 도-미-솔-도
}

/* ── 경험치 ──────────────────────────────── */

// 오른쪽 위 XP 바와 숫자를 지금 장부에 맞게 칠한다
function paintXp() {
  const total = G.total(state.game);
  const info = G.levelInfo(total);
  const today = G.earnedOn(state.game, state.today);

  $('xpLevel').textContent = `Lv.${info.level}`;
  $('xpTitle').textContent = info.title;
  $('xpFill').style.width = `${Math.round((info.into / info.need) * 100)}%`;
  $('xpNums').textContent = `${info.into} / ${info.need} XP`;
  $('xpToday').textContent = today ? `오늘 +${today}` : '';
  $('xpBar').setAttribute('aria-valuemax', String(info.need));
  $('xpBar').setAttribute('aria-valuenow', String(info.into));
  $('xpBox').title = `총 ${total} XP
할일 20 · 급함 30 · 천천히 15 · 하위 할일 10
마감일까지 끝내면 +${G.XP.onTime}`;
}

// 누른 체크박스 위로 '+20 XP' 글자를 띄웠다가 지운다
function xpFloat(anchor, events) {
  const net = events.reduce((sum, e) => sum + e.xp, 0);
  if (!net) return;
  const bonus = events.reduce((sum, e) => sum + e.bonus, 0);

  const rect = anchor.getBoundingClientRect();
  const mark = el('div', `xp-float${net < 0 ? ' loss' : ''}`, `${net > 0 ? '+' : ''}${net} XP`);
  if (bonus) mark.appendChild(el('small', null, `마감 전 +${bonus}`));
  mark.style.left = `${rect.left}px`;
  mark.style.top = `${rect.top - 10}px`;
  document.body.appendChild(mark);
  setTimeout(() => mark.remove(), 900);
}

function showLevelUp(fromLevel, info) {
  const titleBox = $('levelTitle');
  const newTitle = G.titleFor(fromLevel) !== info.title;
  $('levelText').textContent = `Lv.${info.level}`;
  titleBox.textContent = newTitle ? `새 칭호 '${info.title}'` : `다음 레벨까지 ${info.need - info.into} XP`;
  titleBox.classList.toggle('new', newTitle);
  $('levelOverlay').hidden = false;
  fanfare();
}

/**
 * 체크를 바꾼 직후에 부른다. 서버와 같은 규칙(game.js)으로 장부를 먼저 맞춰서,
 * 저장 응답을 기다리지 않고 바로 '+20 XP'를 띄운다. 위치를 잡아야 해서 render()보다 먼저 부른다.
 */
function settleXp(anchor) {
  const before = G.levelInfo(G.total(state.game));
  const { game, events } = G.apply(state.game, state.todos);
  state.game = game;
  if (!events.length) return;

  xpFloat(anchor, events);
  const after = G.levelInfo(G.total(game));
  paintXp();
  if (after.level > before.level) {
    showLevelUp(before.level, after);
  } else if (events.some((e) => e.xp > 0)) {
    $('xpBar').classList.remove('flash');
    void $('xpBar').offsetWidth; // 같은 애니메이션을 처음부터 다시 돌리려면 한 번 끊어 줘야 한다
    $('xpBar').classList.add('flash');
  }
}

/* ── 그리기 ──────────────────────────────── */

function paintToday() {
  $('todayLabel').textContent = `${state.today} (${F.weekdayOf(state.today)})`;
}

const TAB_LABELS = [
  ['today', '오늘'],
  ['week', '이번주'],
  ['overdue', '지난 마감'],
  ['all', '전체'],
  ['done', '완료'],
];

const EMPTY_TEXT = {
  today: '오늘 할 일이 없네요',
  week: '이번주는 비어 있어요',
  overdue: '밀린 일이 없어요. 훌륭해요',
  all: '할 일을 하나 적어 볼까요',
  done: '아직 끝낸 일이 없어요',
};

function renderTabs() {
  const counts = F.counts(state.todos, state.today);
  const box = $('tabs');
  box.textContent = '';

  for (const [view, label] of TAB_LABELS) {
    const tab = el('button', 'tab', label);
    tab.type = 'button';
    tab.dataset.view = view;
    tab.setAttribute('aria-selected', String(state.view === view));
    tab.appendChild(el('span', 'count', String(counts[view] || 0)));
    tab.addEventListener('click', () => {
      state.view = view;
      render();
    });
    box.appendChild(tab);
  }
}

// 픽셀 체크박스. role/aria 속성은 화면 낭독기가 '체크박스, 선택됨'으로 읽게 해 준다.
function makeCheck(checked, label, onToggle) {
  const btn = el('button', 'check');
  btn.type = 'button';
  btn.setAttribute('role', 'checkbox');
  btn.setAttribute('aria-checked', String(checked));
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', () => onToggle(btn));
  return btn;
}

/** 제목을 누르면 그 자리에 입력칸이 생겨 바로 고칠 수 있게 한다. Enter·바깥 클릭 = 저장, Esc = 취소. */
function editable(node, current, onCommit) {
  node.addEventListener('click', () => {
    const input = el('input', 'title-edit');
    input.value = current;
    input.maxLength = 300;
    node.replaceWith(input);
    input.focus();
    input.select();

    let settled = false; // Enter 뒤에 blur가 또 와도 한 번만 처리
    const finish = (save) => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      if (save && next && next !== current) onCommit(next);
      else render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  });
}

// 하위 할일 진행 칸(■■□□ 2/4). 칸은 12개까지만 그린다.
function progressEl(todo) {
  const subs = todo.subtasks || [];
  const doneCount = subs.filter((s) => s.done).length;
  const wrap = el('div', 'prog');
  for (let i = 0; i < Math.min(subs.length, 12); i += 1) {
    wrap.appendChild(el('span', `prog-cell${i < doneCount ? ' on' : ''}`));
  }
  wrap.appendChild(el('span', 'prog-text', `${doneCount}/${subs.length}`));
  return wrap;
}

function toggleTodo(todo, btn) {
  todo.done = !todo.done;
  todo.doneAt = todo.done ? new Date().toISOString() : null;
  blip(todo.done ? 880 : 330);
  settleXp(btn);
  commit();
}

function toggleSub(todo, sub, btn) {
  sub.done = !sub.done;
  sub.doneAt = sub.done ? new Date().toISOString() : null;

  // 하위를 전부 끝내면 본 할일도 끝난 것으로, 하나라도 풀면 본 할일도 다시 안 끝난 것으로
  const allDone = todo.subtasks.every((s) => s.done);
  if (allDone && !todo.done) {
    todo.done = true;
    todo.doneAt = new Date().toISOString();
    blip(1046);
    toast('전부 끝냈어요');
  } else if (!allDone && todo.done) {
    todo.done = false;
    todo.doneAt = null;
  } else {
    blip(sub.done ? 740 : 320);
  }

  settleXp(btn);
  commit();
}

/** 삭제는 두 번 눌러야 지워진다. 처음 누르면 '정말?'로 바뀌고 3초 안에 한 번 더 눌러야 한다. */
function makeDeleteBtn(onConfirm) {
  const btn = el('button', 'icon-btn', 'X');
  btn.type = 'button';
  btn.title = '삭제';
  let armed = false;
  let timer = null;

  btn.addEventListener('click', () => {
    if (armed) {
      clearTimeout(timer);
      onConfirm();
      return;
    }
    armed = true;
    btn.textContent = '정말?';
    blip(220);
    timer = setTimeout(() => {
      armed = false;
      btn.textContent = 'X';
    }, 3000);
  });
  return btn;
}

function smallBtn(text, className, title, onClick) {
  const btn = el('button', `pbtn pbtn-sm ${className}`, text);
  btn.type = 'button';
  if (title) btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

// 마감일·알림·우선순위 배지와 진행 칸 줄
function metaEl(todo, bucket) {
  const meta = el('div', 'meta');
  if (todo.due) {
    const mod = bucket === 'overdue' ? ' late' : bucket === 'today' ? ' today' : '';
    meta.appendChild(el('span', `badge badge-due${mod}`, F.dueLabel(todo.due, state.today)));
  }
  if (todo.remindAt) {
    const rung = Boolean(todo.remindedAt);
    const badge = el('span', `badge badge-remind${rung ? ' sent' : ''}`, `⏰ ${F.remindLabel(todo.remindAt, state.today)}`);
    badge.title = rung ? '이미 알려 드린 알림입니다' : '맞춰 둔 알림';
    meta.appendChild(badge);
  }
  if (todo.priority === 'high') meta.appendChild(el('span', 'badge badge-prio-high', '급함'));
  if (todo.priority === 'low') meta.appendChild(el('span', 'badge badge-prio-low', '천천히'));
  if (todo.subtasks.length) meta.appendChild(progressEl(todo));
  return meta;
}

// 하위 할일 목록
function subsEl(todo) {
  const list = el('ul', 'subs');
  for (const sub of todo.subtasks) {
    const row = el('li', `sub${sub.done ? ' done' : ''}`);
    row.appendChild(makeCheck(sub.done, `${sub.title} 완료`, (btn) => toggleSub(todo, sub, btn)));

    const subTitle = el('span', 'sub-title', sub.title);
    editable(subTitle, sub.title, (next) => {
      sub.title = next;
      commit();
    });
    row.appendChild(subTitle);

    row.appendChild(
      makeDeleteBtn(() => {
        todo.subtasks = todo.subtasks.filter((s) => s.id !== sub.id);
        commit();
      })
    );
    list.appendChild(row);
  }
  return list;
}

/** 할일 카드 하나: [체크] 제목·배지·메모 [쪼개기][⏰][메모][X], 그 아래 하위 할일. */
function cardEl(todo) {
  const bucket = F.bucket(todo, state.today);
  const card = el('div', `card${bucket === 'overdue' ? ' is-overdue' : ''}${todo.done ? ' is-done' : ''}`);

  const main = el('div', 'card-main');
  main.appendChild(makeCheck(todo.done, `${todo.title} 완료`, (btn) => toggleTodo(todo, btn)));

  const body = el('div', 'card-body');
  const title = el('span', 'title', todo.title);
  title.title = '눌러서 고치기';
  editable(title, todo.title, (next) => {
    todo.title = next;
    commit();
  });
  body.appendChild(title);

  const meta = metaEl(todo, bucket);
  if (meta.childNodes.length) body.appendChild(meta);

  if (todo.note) {
    const memo = el('p', 'card-memo', todo.note);
    memo.title = '눌러서 메모 고치기';
    memo.addEventListener('click', () => openMemo(todo.id));
    body.appendChild(memo);
  }
  main.appendChild(body);

  const actions = el('div', 'card-actions');
  // 끝난 할일에는 쪼개기·알림 버튼이 필요 없다
  if (!todo.done) {
    actions.appendChild(smallBtn('쪼개기', 'pbtn-grape', null, () => openSplit(todo.id)));
    const remindTitle = todo.remindAt ? `알림 ${F.remindLabel(todo.remindAt, state.today)}` : '알림 맞추기';
    actions.appendChild(smallBtn('⏰', todo.remindAt ? 'pbtn-sky' : 'pbtn-ghost', remindTitle, () => openRemind(todo.id)));
  }
  actions.appendChild(
    smallBtn('메모', todo.note ? 'pbtn-lemon' : 'pbtn-ghost', todo.note ? '메모 고치기' : '메모 달기', () => openMemo(todo.id))
  );
  actions.appendChild(
    makeDeleteBtn(() => {
      state.todos = state.todos.filter((t) => t.id !== todo.id);
      commit();
      toast('지웠습니다');
    })
  );
  main.appendChild(actions);
  card.appendChild(main);

  if (todo.subtasks.length) card.appendChild(subsEl(todo));
  return card;
}

/** 화면 전체 다시 그리기: 탭 → 지금 탭에 맞는 카드들 → 비었으면 안내 문구 */
function render() {
  renderTabs();

  const visible = F.filterTodos(state.todos, state.view, state.today);
  const list = $('list');
  list.textContent = '';
  for (const todo of visible) list.appendChild(cardEl(todo));

  $('empty').hidden = visible.length > 0;
  $('emptyText').textContent = EMPTY_TEXT[state.view] || '비어 있어요';
}

/* ── 추가 ────────────────────────────────── */

function addTodo(title) {
  const clean = title.trim();
  if (!clean) return;

  const todo = {
    id: newId(),
    title: clean,
    note: '',
    due: $('addDue').value || null,
    priority: $('addPriority').value,
    done: false,
    doneAt: null,
    createdAt: new Date().toISOString(),
    subtasks: [],
  };
  state.todos.push(todo);

  // 방금 넣은 할일이 지금 탭에 안 보이면 사라진 것처럼 느껴진다(예: 마감 없는 일 + 오늘 탭). 그럴 땐 전체 탭으로.
  if (!F.matchesView(todo, state.view, state.today)) state.view = 'all';

  $('addTitle').value = '';
  blip(560);
  commit();
}

/* ── 쪼개기 창 ────────────────────────────── */
// 창 안이 세 단계로 바뀐다: 1(설명 입력) → loading(기다리는 중) → 2(결과 고르기)

function showStage(stage) {
  $('splitStage1').hidden = stage !== 1;
  $('splitLoading').hidden = stage !== 'loading';
  $('splitStage2').hidden = stage !== 2;
}

function openSplit(id) {
  const todo = findTodo(id);
  if (!todo) return;

  state.splitTargetId = id;
  $('splitTarget').textContent = todo.title;
  $('splitNote').value = todo.note || ''; // 메모가 있으면 설명 칸에 미리 채운다 (같은 칸)
  $('splitResults').textContent = '';
  showError('splitError', state.claudeReady ? '' : 'claude CLI를 찾지 못했습니다. 터미널에서 claude 명령이 되는지 확인해 주세요.');
  showStage(1);
  $('splitOverlay').hidden = false;
  $('splitNote').focus();
}

async function runSplit() {
  const todo = findTodo(state.splitTargetId);
  if (!todo) return;

  todo.note = $('splitNote').value.trim();
  persist(); // 고친 설명(메모)을 기다리는 동안 잃지 않게 먼저 저장
  showError('splitError', '');
  showStage('loading');

  try {
    // 서버가 claude를 실행해 답을 줄 때까지 기다린다 (10~20초)
    const { subtasks } = await api('POST', '/api/split', { title: todo.title, note: todo.note });

    // 결과마다 체크박스 한 줄. 처음엔 전부 체크된 상태로 보여 주고, 빼고 싶은 것만 풀게 한다.
    const list = $('splitResults');
    list.textContent = '';
    subtasks.forEach((text, i) => {
      const row = el('li');
      const label = el('label', null, text);
      label.id = `split-item-${i}`;
      const check = makeCheck(true, text, (btn) => {
        const next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        blip(next ? 700 : 300, 0.04);
      });
      check.setAttribute('aria-labelledby', label.id);
      check.dataset.text = text;
      row.append(check, label);
      list.appendChild(row);
    });

    showStage(2);
    blip(920);
  } catch (err) {
    showStage(1);
    showError('splitError', err.message);
  }
}

function addSelectedSubtasks() {
  const todo = findTodo(state.splitTargetId);
  if (!todo) return;

  const picked = [...$('splitResults').querySelectorAll('.check')]
    .filter((c) => c.getAttribute('aria-checked') === 'true')
    .map((c) => c.dataset.text);

  if (!picked.length) {
    showError('splitError', '하나 이상 골라 주세요.');
    return;
  }

  todo.subtasks.push(...picked.map((title) => ({ id: newId(), title, done: false, doneAt: null })));

  $('splitOverlay').hidden = true;
  commit();
  toast(`${picked.length}개로 쪼갰습니다`);
  blip(1046);
}

/* ── 알림 창 ──────────────────────────────── */

const REMIND_HOUR = '09:00';

// 날짜·시각 칸 두 개를 'YYYY-MM-DDTHH:mm' 하나로. 비었거나 이상하면 null.
function readRemindValue() {
  const date = $('remindDate').value;
  const time = ($('remindTime').value || '').slice(0, 5);
  if (!date || !time) return null;
  const value = `${date}T${time}`;
  return F.isDateTimeStr(value) ? value : null;
}

/** 고른 시각이 지금부터 얼마 뒤인지 말로 알려 준다. 지난 시각이면 눈에 띄게. */
function paintRemindHint() {
  const box = $('remindHint');
  const value = readRemindValue();
  box.classList.remove('warn');
  if (!value) {
    box.textContent = '';
    return;
  }

  const mins = Math.round((F.parseLocalDateTime(value) - Date.now()) / 60000);
  if (mins < 0) {
    box.textContent = '이미 지난 시각이에요';
    box.classList.add('warn');
  } else if (mins < 60) {
    box.textContent = `${mins}분 뒤에 알려 드려요`;
  } else if (mins < 60 * 24) {
    box.textContent = `${Math.floor(mins / 60)}시간 ${mins % 60}분 뒤에 알려 드려요`;
  } else {
    box.textContent = `${Math.floor(mins / (60 * 24))}일 뒤에 알려 드려요`;
  }
}

function setRemindFields(date, time) {
  $('remindDate').value = date;
  $('remindTime').value = time;
  paintRemindHint();
}

function fillFromNow(minutes) {
  const [date, time] = F.toDateTimeStr(new Date(Date.now() + minutes * 60000)).split('T');
  setRemindFields(date, time);
}

function openRemind(id) {
  const todo = findTodo(id);
  if (!todo) return;

  state.remindTargetId = id;
  $('remindTarget').textContent = todo.title;
  showError('remindError', '');

  // 창을 열 때 기본값: 맞춰 둔 시각 → 없으면 마감일 아침 9시 → 그것도 없으면 1시간 뒤
  if (F.isDateTimeStr(todo.remindAt)) setRemindFields(...todo.remindAt.split('T'));
  else if (todo.due) setRemindFields(todo.due, REMIND_HOUR);
  else fillFromNow(60);

  $('remindOverlay').hidden = false;
  $('remindTime').focus();
}

function saveRemind() {
  const todo = findTodo(state.remindTargetId);
  if (!todo) return;

  const value = readRemindValue();
  if (!value) return showError('remindError', '날짜와 시각을 모두 채워 주세요.');
  if (F.parseLocalDateTime(value) <= new Date()) return showError('remindError', '지난 시각이에요. 앞으로의 시각을 골라 주세요.');

  todo.remindAt = value;
  todo.remindedAt = null; // 새로 맞췄으니 다시 울려야 한다
  $('remindOverlay').hidden = true;
  commit();
  toast(`${F.remindLabel(value, state.today)}에 알려 드릴게요`);
  blip(880);
}

function clearRemind() {
  const todo = findTodo(state.remindTargetId);
  if (!todo) return;

  todo.remindAt = null;
  todo.remindedAt = null;
  $('remindOverlay').hidden = true;
  commit();
  toast('알림을 껐습니다');
  blip(330);
}

function bindRemind() {
  for (const chip of document.querySelectorAll('[data-remind-quick]')) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.remindQuick; // HTML의 data-remind-quick="30" 값
      if (value === 'tomorrow9') setRemindFields(F.addDays(F.todayStr(), 1), REMIND_HOUR);
      else fillFromNow(Number(value));
      blip(660, 0.04);
    });
  }
  $('remindDate').addEventListener('change', paintRemindHint);
  $('remindTime').addEventListener('change', paintRemindHint);
  $('remindSave').addEventListener('click', saveRemind);
  $('remindClear').addEventListener('click', clearRemind);
}

/* ── 메모 창 ──────────────────────────────── */
// 메모는 할일의 note 칸에 저장된다. 쪼개기 창의 '덧붙일 설명'과 같은 칸이다.

const MEMO_MAX = 2000;

function paintMemoCount() {
  $('memoCount').textContent = `${$('memoText').value.length} / ${MEMO_MAX}`;
}

function openMemo(id) {
  const todo = findTodo(id);
  if (!todo) return;

  state.memoTargetId = id;
  $('memoTarget').textContent = todo.title;
  $('memoText').value = todo.note || '';
  $('memoClear').hidden = !todo.note; // 지울 메모가 없으면 '메모 지우기' 버튼을 숨긴다
  paintMemoCount();
  $('memoOverlay').hidden = false;
  $('memoText').focus();
}

// 저장·지우기 둘 다 여기로 온다. 빈 글을 저장하면 지우기와 같다.
function writeMemo(text) {
  const todo = findTodo(state.memoTargetId);
  if (!todo) return;

  const had = Boolean(todo.note);
  todo.note = text.trim();
  $('memoOverlay').hidden = true;
  commit();
  if (todo.note) toast(had ? '메모를 고쳤습니다' : '메모를 달았습니다');
  else if (had) toast('메모를 지웠습니다');
  blip(todo.note ? 760 : 330);
}

function bindMemo() {
  $('memoText').addEventListener('input', paintMemoCount);
  $('memoText').addEventListener('keydown', (e) => {
    // Ctrl+Enter(맥은 Cmd+Enter)로 바로 저장. 그냥 Enter는 줄바꿈.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      writeMemo($('memoText').value);
    }
  });
  $('memoSave').addEventListener('click', () => writeMemo($('memoText').value));
  $('memoClear').addEventListener('click', () => writeMemo(''));
}

/* ── 업무일지 창 ──────────────────────────── */

async function openLog() {
  showError('logError', '');
  try {
    const { markdown } = await api('POST', '/api/worklog/preview', { date: state.today });
    $('logPreview').textContent = markdown;
    $('logOverlay').hidden = false;
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveLog() {
  try {
    const result = await api('POST', '/api/worklog/save', { date: state.today });
    $('logOverlay').hidden = true;
    toast(result.created ? '일지를 새로 만들었습니다' : '일지에 기록했습니다');
    blip(1046);
  } catch (err) {
    showError('logError', err.message);
  }
}

async function copyLog() {
  try {
    await navigator.clipboard.writeText($('logPreview').textContent);
    toast('복사했습니다');
  } catch {
    toast('복사하지 못했습니다. 직접 선택해 주세요.', true);
  }
}

/* ── 시작 ────────────────────────────────── */

// 입력칸 아래 '오늘·내일·일주일·없음' 칩
function bindQuickDates() {
  const chips = document.querySelectorAll('[data-quick]');
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.quick;
      $('addDue').value = value === 'none' ? '' : F.addDays(state.today, Number(value));
      for (const other of chips) other.setAttribute('aria-pressed', String(other === chip));
      $('addTitle').focus();
    });
  }
}

// 창 닫기: X 버튼, 창 바깥 어두운 곳 클릭, Esc 키
function bindModals() {
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => {
      $(btn.dataset.close).hidden = true;
    });
  }
  for (const overlay of document.querySelectorAll('.overlay')) {
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) overlay.hidden = true; // 창 안쪽이 아니라 바깥 배경을 눌렀을 때만
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const overlay of document.querySelectorAll('.overlay')) overlay.hidden = true;
  });
}

function bindSound() {
  const btn = $('soundBtn');
  const paint = () => {
    btn.textContent = soundOn ? '♪ ON' : '♪ OFF';
    btn.setAttribute('aria-pressed', String(soundOn));
  };
  btn.addEventListener('click', () => {
    soundOn = !soundOn;
    localStorage.setItem('todoSound', soundOn ? 'on' : 'off');
    paint();
    blip(660);
  });
  paint();
}

// 저장 중이거나, 창(모달)을 열어 두었거나, 제목을 고치는 중이면 내 손에 든 값이 서버보다 최신이다
const editing = () =>
  Boolean(saving) ||
  Boolean(document.querySelector('.title-edit')) ||
  [...document.querySelectorAll('.overlay')].some((o) => !o.hidden);

// 서버에서 목록·장부·오늘 날짜를 받아 state에 넣는다.
// canApply: 받아 오는 사이 사용자가 무언가 고치기 시작했으면 덮어쓰지 않으려고 받기 직후 한 번 더 묻는다.
async function loadFromServer(canApply = () => true) {
  const data = await api('GET', '/api/todos');
  if (!canApply()) return;
  state.todos = data.todos;
  state.today = data.today;
  state.claudeReady = data.claudeReady;
  state.game = data.game;
}

async function start() {
  // 마스코트 고양이를 네 군데(머리, 빈 화면, 로딩, 레벨업)에 그린다
  for (const id of ['mascot', 'emptyMascot', 'loadMascot', 'levelMascot']) $(id).appendChild(spriteSvg(CAT));
  $('loadMascot').classList.add('sprite-hop');

  paintToday();

  // 버튼마다 할 일을 연결한다
  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault(); // form의 기본 동작(페이지 새로고침)을 막는다
    addTodo($('addTitle').value);
  });
  $('splitRun').addEventListener('click', runSplit);
  $('splitRetry').addEventListener('click', runSplit);
  $('splitAdd').addEventListener('click', addSelectedSubtasks);
  $('exportBtn').addEventListener('click', openLog);
  $('logSave').addEventListener('click', saveLog);
  $('logCopy').addEventListener('click', copyLog);

  bindQuickDates();
  bindModals();
  bindSound();
  bindRemind();
  bindMemo();

  // 창을 하루 종일 열어 두면 '오늘'이 어제로 굳는다. 이 창으로 돌아올 때마다 날짜와 목록을 다시 받는다.
  // 그사이 서버가 알림을 울리거나 미뤘을 수도 있어서 목록도 같이 받는다.
  window.addEventListener('focus', async () => {
    state.today = F.todayStr();
    const idle = () => !editing();
    if (idle()) {
      try {
        await loadFromServer(idle);
      } catch {
        /* 못 받아와도 화면은 그대로 두면 된다 */
      }
    }
    paintToday();
    paintXp();
    render();
  });

  try {
    await loadFromServer();
  } catch (err) {
    toast(err.message, true);
  }

  // 오늘 할 일이 없으면 전체 탭을 먼저 보여 준다
  if (!F.counts(state.todos, state.today).today && state.todos.length) state.view = 'all';

  paintXp();
  render();
  $('addTitle').focus();
}

start();
