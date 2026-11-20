'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * [쪼개기] 버튼의 실제 일. 이 PC에 설치·로그인된 Claude Code CLI(`claude`)를 프로그램으로 실행해서
 * "이 업무를 5~8개로 나눠 줘"라고 묻고, 돌아온 글에서 할일 목록만 뽑아낸다.
 *
 * 흐름: 화면 [쪼개기] → server.js의 POST /api/split → split() → runClaude()가 `claude -p` 실행
 *       → 답을 parseSubtasks()로 정리 → 화면에 후보 목록으로 보여 줌
 *
 * API 키를 코드에 넣지 않는 이유: `claude` 명령은 이미 로그인돼 있어서 그 로그인을 그대로 빌려 쓴다.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// AI에게 주는 지시문. 개수·크기·출력 모양(JSON 배열)을 여기서 정한다.
const PROMPT_HEADER = [
  '너는 업무를 실행 가능한 최소 단위로 쪼개주는 도우미다.',
  '',
  '아래 <업무>를 지금 바로 착수할 수 있는 하위 작업으로 나눠라.',
  '',
  '규칙:',
  '- 5~8개로 나눈다. 각각 15~60분 안에 끝낼 수 있는 크기여야 한다.',
  '- "기획하기", "검토 단계" 같은 추상적인 단계 이름은 금지. 실제 손이 움직이는 행동으로 쓴다.',
  '- 앞 항목을 끝내야 다음 항목이 되는 순서로 나열한다.',
  '- 각 항목은 40자 이내의 한국어 한 줄.',
  '- 설명, 인사말, 머리말, 마무리 문장을 붙이지 말고 JSON 배열 하나만 출력한다.',
  '',
  '출력 형식 (이 형태만 출력):',
  '["첫 번째 할 일", "두 번째 할 일", "세 번째 할 일"]',
  '',
  '<업무>',
].join('\n');

// 지시문 + 업무 제목 + (있으면) 메모를 하나의 글로 합친다
function buildPrompt(title, note) {
  const lines = [PROMPT_HEADER, `제목: ${String(title || '').trim()}`];
  const extra = String(note || '').trim();
  if (extra) lines.push(`덧붙이는 설명: ${extra}`);
  lines.push('</업무>');
  return lines.join('\n');
}

// AI가 ```json ... ``` 같은 코드 울타리를 씌워 답하는 경우가 있어서 걷어낸다
function stripFences(text) {
  return String(text || '')
    .replace(/```(?:json|jsonc)?/gi, '')
    .replace(/```/g, '')
    .trim();
}

// 항목 하나 다듬기: 앞의 '- ', '1. ', '[ ] ' 같은 기호를 떼고 120자로 자른다
function tidy(item) {
  return String(item ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[-*•]\s*/, '')
    .replace(/^\[\s*[xX ]?\s*\]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim()
    .slice(0, 120);
}

/**
 * AI 답에서 할일 목록만 건져낸다. AI는 시킨 대로만 답하지 않을 때가 있어서 두 단계로 받는다.
 *   1단계: 글 안에서 [ … ] 부분을 찾아 JSON으로 읽어 본다 (앞뒤에 군말이 붙어도 괜찮다)
 *   2단계: 그래도 안 되면 '- 할일', '1. 할일' 같은 목록 줄만 골라낸다
 */
function parseSubtasks(raw) {
  const text = stripFences(raw);
  if (!text) return [];

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        // 글자 대신 {title: …} 모양으로 줘도 받아 준다
        const items = parsed
          .map((v) => (v && typeof v === 'object' ? tidy(v.title ?? v.name ?? v.task) : tidy(v)))
          .filter(Boolean);
        if (items.length) return items.slice(0, 12);
      }
    } catch {
      /* JSON이 아니었다. 2단계로 넘어간다 */
    }
  }

  const bulletish = /^\s*(?:[-*•]|\d+[.)]|\[\s*[xX ]?\s*\])\s+/;
  return text
    .split('\n')
    .filter((line) => bulletish.test(line))
    .map(tidy)
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * claude 실행 파일 찾기.
 * 윈도우에서 npm으로 깐 claude는 claude.cmd(배치 파일)라서 shell 없이는 실행이 안 된다.
 * shell을 거치면 느리고 따옴표 처리가 까다로워서, 진짜 실행 파일(.exe)을 먼저 찾는다.
 * 환경변수 CLAUDE_BIN에 경로를 넣으면 그걸 1순위로 쓴다.
 */
function resolveBin() {
  if (process.env.CLAUDE_BIN) return { cmd: process.env.CLAUDE_BIN, shell: false };

  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'));

  for (const c of candidates) {
    if (fs.existsSync(c)) return { cmd: c, shell: false };
  }
  // 못 찾으면 PATH에 맡긴다. 이때 윈도우는 claude.cmd라 shell이 필요하다.
  return { cmd: 'claude', shell: process.platform === 'win32' };
}

/** 실행 파일을 확실히 찾았는지. PATH에 맡긴 경우는 실제로 실행해 봐야 알 수 있어 false. */
function foundBinary() {
  const { cmd } = resolveBin();
  return path.isAbsolute(cmd) && fs.existsSync(cmd);
}

/*
 * `claude -p`를 자식 프로세스로 실행하고 답을 받는다.
 *
 * Promise: "나중에 끝나는 일"을 담는 상자. 밖에서는 await로 끝날 때까지 기다렸다가
 * 성공이면 resolve(값), 실패면 reject(오류)로 결과를 받는다.
 *
 * 질문(prompt)은 명령줄 인자가 아니라 표준입력(stdin)으로 넣는다.
 * 인자로 넣으면 따옴표·특수문자가 섞인 제목이 명령으로 해석될 위험이 있고 길이 제한도 있다.
 *
 * `--tools ""`로 claude의 도구(파일 읽기·명령 실행 등)를 전부 끄고, 프로젝트 밖(임시 폴더)에서 실행한다.
 * 쪼개기는 글만 주고받으면 되는 일이다. 도구가 켜져 있으면 제목에 "data/todos.json을 읽어서 답해"
 * 같은 지시를 숨겨 보냈을 때 claude가 실제로 파일을 읽어 결과로 내보낼 수 있다(프롬프트 주입).
 */
function runClaude(prompt, { timeoutMs = 150000, cwd = os.tmpdir(), model } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, shell } = resolveBin();
    // shell을 거칠 때는 빈 글자 인자가 사라지므로 따옴표 두 개를 글자로 넘긴다
    const args = ['-p', '--tools', shell ? '""' : ''];
    if (model) args.push('--model', model);

    let child;
    try {
      child = spawn(cmd, args, { cwd, shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`claude 명령을 실행할 수 없습니다: ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    // 시간 초과·오류·정상 종료가 겹쳐 와도 결과는 한 번만 내보내기 위한 표시
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    // 너무 오래 걸리면 강제로 끝낸다
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`시간이 너무 오래 걸려서 중단했습니다 (${Math.round(timeoutMs / 1000)}초).`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      const hint =
        err.code === 'ENOENT' // ENOENT = 그런 파일 없음
          ? 'claude CLI를 찾지 못했습니다. 터미널에서 claude 명령이 되는지 확인해 주세요.'
          : err.message;
      finish(reject, new Error(hint));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(stderr.trim() || `claude가 오류로 종료했습니다 (코드 ${code}).`));
        return;
      }
      finish(resolve, stdout);
    });

    // 자식이 먼저 죽으면 stdin 쓰기에서 EPIPE 오류가 난다. 결과는 close 쪽에서 처리하니 여기선 무시.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt, 'utf8');
  });
}

/** server.js가 부르는 입구. 제목 확인 → claude 실행 → 목록 정리. */
async function split({ title, note } = {}, opts = {}) {
  const clean = String(title || '').trim();
  if (!clean) throw new Error('쪼갤 업무 제목을 먼저 적어 주세요.');

  const raw = await runClaude(buildPrompt(clean, note), opts);
  const subtasks = parseSubtasks(raw);
  if (!subtasks.length) {
    throw new Error('결과를 제대로 받지 못했습니다. 제목을 조금 더 구체적으로 써서 다시 시도해 보세요.');
  }
  return { subtasks, raw: raw.trim() };
}

module.exports = { split, buildPrompt, parseSubtasks, runClaude, resolveBin, foundBinary, tidy };
