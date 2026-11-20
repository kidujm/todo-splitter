'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 알림 시계. 서버가 켜져 있는 동안 30초마다 할일 파일을 읽어서
 * "알림 시각이 지났는데 아직 안 울린 할일"이 있으면 popup.js로 팝업을 띄운다.
 *
 * 각 할일에는 알림 관련 칸이 두 개 있다.
 *   remindAt    언제 울릴지 ('2026-11-20T15:00')
 *   remindedAt  이미 울렸으면 그 시각, 아직이면 null  →  같은 알림이 두 번 뜨지 않게 하는 표시
 *
 * 판단하는 함수(pickDue 등)와 실제로 돌리는 함수(start)를 나눠 뒀다.
 * 판단 함수는 파일도 팝업도 안 건드리는 순수 함수라서, 시각만 넣어 가며 테스트할 수 있다.
 */

const { parseLocalDateTime, toDateTimeStr } = require('./filters');

/** 이보다 오래 지난 알림은 팝업 없이 지나간 것으로 친다.
 *  주말 내내 PC를 꺼 뒀다가 켰을 때 묵은 팝업이 쏟아지면 안 되니까. */
const STALE_MS = 12 * 60 * 60 * 1000;

/** 30초면 사람이 느끼기엔 제때고, 파일 하나 읽는 부담은 없다시피 하다. */
const TICK_MS = 30_000;

const SNOOZE_MIN = 10;

/**
 * 지금 울려야 할 것과, 너무 늦어 조용히 넘길 것을 갈라낸다.
 * 순수 함수라 시간을 넣어 가며 테스트할 수 있다.
 */
function pickDue(todos, now = new Date()) {
  const fire = [];
  const stale = [];

  for (const todo of todos || []) {
    if (!todo || todo.done) continue;
    if (todo.remindedAt) continue; // 이미 울렸다

    const at = parseLocalDateTime(todo.remindAt);
    if (!at || at.getTime() > now.getTime()) continue;

    if (now.getTime() - at.getTime() > STALE_MS) stale.push(todo);
    else fire.push(todo);
  }
  return { fire, stale };
}

function snoozeAt(now, minutes) {
  return toDateTimeStr(new Date(now.getTime() + minutes * 60_000));
}

/** 울렸다는 표시. remindAt은 남겨 둬야 언제 알림이었는지 화면에 보여줄 수 있다. */
function markSent(todo, now = new Date()) {
  todo.remindedAt = now.toISOString();
  return todo;
}

/** 다시 알림: 시각을 미루고 '울림' 표시를 지운다. */
function applySnooze(todo, minutes = SNOOZE_MIN, now = new Date()) {
  todo.remindAt = snoozeAt(now, minutes);
  todo.remindedAt = null;
  return todo;
}

/**
 * 브라우저가 보낸 목록에 서버가 쥐고 있던 알림 상태를 되살린다.
 *
 * 브라우저는 자기 화면의 목록 전체를 PUT으로 덮어쓴다. 그래서 알림이 울린 직후
 * 브라우저가 저장하면 remindedAt이 지워져 같은 알림이 30초 뒤에 또 뜬다.
 * 반대로 사용자가 알림 시각을 진짜로 바꿨다면 그건 다시 울리라는 뜻이니 살려야 한다.
 *
 * 둘을 이렇게 가른다.
 *  1) 시각이 그대로면      → 사용자가 알림을 건드린 게 아니다. 서버의 울림 표시를 지킨다.
 *  2) 시각이 다른데 브라우저 쪽에만 울림 표시가 있으면
 *                          → 서버가 스누즈로 시각을 미룬 뒤다. 브라우저 값이 낡았으므로 서버가 이긴다.
 *  3) 그 밖에 시각이 다르면 → 사용자가 직접 바꿨다. 브라우저가 이긴다.
 */
function preserveSent(incoming, current) {
  const onDisk = new Map((current || []).map((t) => [t.id, t]));

  return (incoming || []).map((todo) => {
    const saved = onDisk.get(todo.id);
    if (!saved) return todo;

    if (saved.remindAt === todo.remindAt) {
      return { ...todo, remindedAt: saved.remindedAt };
    }
    if (todo.remindedAt && !saved.remindedAt) {
      return { ...todo, remindAt: saved.remindAt, remindedAt: saved.remindedAt };
    }
    return todo;
  });
}
function popupKind(todo) {
  return todo && todo.priority === 'high' ? 'window' : 'toast';
}

// 팝업 본문: 제목 + (있으면) 다음에 할 하위 할일 하나
function bodyFor(todo) {
  const next = (todo.subtasks || []).find((s) => !s.done);
  return next ? `${todo.title}\n다음: ${next.title}` : todo.title;
}

/**
 * 알림 루프를 시작한다. store(파일)와 popup(팝업)을 밖에서 넣어 준다.
 * 이렇게 하면 테스트에서는 진짜 파일·팝업 대신 가짜를 넣어 시험할 수 있다(의존성 주입).
 *
 * 팝업을 띄우기 '전에' 울림 표시를 먼저 저장한다.
 * 팝업이 떠 있는 도중에 서버가 꺼져도, 다시 켰을 때 같은 알림이 또 뜨지 않게.
 */
function start({ store, popup, intervalMs = TICK_MS, onError = () => {} } = {}) {
  // 급한 일 창은 사용자가 누를 때까지 안 닫힌다. 그 사이 30초가 또 지나도 확인을 겹쳐 돌리지 않게 막는 표시.
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const todos = store.load();
      const now = new Date();
      const { fire, stale } = pickDue(todos, now);
      if (!fire.length && !stale.length) return;

      for (const todo of [...fire, ...stale]) markSent(todo, now);
      store.save(todos);

      for (const todo of fire) {
        let answer = 'ok';
        try {
          answer = await popup.show({
            kind: popupKind(todo),
            title: todo.priority === 'high' ? '지금 할 시간' : '할일 쪼개기',
            body: bodyFor(todo),
          });
        } catch (err) {
          onError(err);
        }
        if (answer !== 'snooze') continue;

        // 팝업이 떠 있는 동안 브라우저가 파일을 바꿨을 수 있어 다시 읽는다.
        const fresh = store.load();
        const target = fresh.find((t) => t.id === todo.id);
        if (!target) continue;
        applySnooze(target, SNOOZE_MIN, new Date());
        store.save(fresh);
      }
    } catch (err) {
      onError(err);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  tick();

  return { tick, stop: () => clearInterval(timer) };
}

module.exports = {
  pickDue,
  snoozeAt,
  markSent,
  applySnooze,
  popupKind,
  preserveSent,
  bodyFor,
  start,
  STALE_MS,
  TICK_MS,
  SNOOZE_MIN,
};
