'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 화면에 알림을 띄운다. 외부 패키지 없이 하려고 운영체제에 들어 있는 스크립트 도구를 빌려 쓴다.
 *   - 윈도우: PowerShell (아래 대부분의 코드)
 *   - 맥    : osascript(AppleScript). 제목·본문은 스크립트 글에 넣지 않고 인자로 넘겨서 따옴표 처리가 필요 없다
 *   - 그 밖 : 팝업 없이 넘어간다 (서버와 다른 기능은 그대로 돈다)
 * 알림은 두 종류다.
 *   - 토스트: 화면 구석에 뜨고 알림 센터에 남는 표준 알림 (보통·천천히 할일)
 *   - 창    : 화면 가운데에 뜨고 버튼을 누를 때까지 남는 창 (급한 할일, 아침 브리핑)
 *
 * 윈도우 함정 두 가지:
 *   1) 토스트 기능(WinRT)은 PowerShell 7(pwsh)에서 못 불러온다. 반드시 Windows PowerShell 5.1을 쓴다.
 *   2) 스크립트를 파일로 넘기면 5.1이 한글을 깨뜨린다. 그래서 -EncodedCommand로
 *      스크립트를 UTF-16LE + base64로 바꿔 명령줄에 통째로 넘긴다.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

// String.raw`…`: 역슬래시(\)를 글자 그대로 둔다. 일반 따옴표 안의 \v, \n 등은 특수문자로 바뀌어 버린다.
const POWERSHELL =
  process.env.TODO_POWERSHELL ||
  path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** 토스트는 '어느 앱이 보낸 알림인지' ID가 있어야 뜬다. 따로 등록하지 않고 PowerShell의 ID를 빌린다. */
const APP_ID = String.raw`{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`;

const MAX_TEXT = 120;

/** 창을 잊고 놔둬도 5분 뒤엔 닫히게. 이때는 '확인'으로 친다. */
const WINDOW_TIMEOUT_MS = 5 * 60 * 1000;

/** 창에서 '10분 뒤'를 누르면 PowerShell이 이 번호로 끝난다. Node는 종료 번호로 무슨 버튼이었는지 안다. */
const EXIT_SNOOZE = 2;
const SNOOZE_LABEL = '10분 뒤';

// 팝업 색: 남색 바탕, 노란 제목, 크림색 본문 (화면 테마와 맞춤)
const INK = '#2d2a3e';
const LEMON = '#ffd670';
const CREAM = '#fff5e4';

// 토스트 내용은 XML이라 <, & 같은 글자를 그대로 넣으면 깨진다. 안전한 글자로 바꾼다.
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 글자를 PowerShell 작은따옴표 문자열로 감싼다. 안의 작은따옴표는 두 번(' → '') 써서 막는다.
 * 할일 제목이 스크립트에 그대로 들어가기 때문에 중요하다. 이걸 안 하면 제목에 '; 명령' 같은 걸
 * 넣었을 때 그게 명령으로 실행될 수 있다(코드 주입).
 * PowerShell은 둥근 작은따옴표(‘ ’ ‚ ‛, 워드·카톡에서 붙여 넣으면 잘 섞인다)도 따옴표로 읽어서 같이 두 번 쓴다.
 */
function psQuote(s) {
  return `'${String(s ?? '').replace(/['‘-‛]/g, '$&$&')}'`;
}

function trim(s) {
  return String(s ?? '').slice(0, MAX_TEXT);
}

function buildToastXml({ title, body }) {
  const lines = String(body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2);

  const texts = [trim(title), ...lines.map(trim)]
    .map((t) => `<text>${xmlEscape(t)}</text>`)
    .join('');

  return `<toast duration="long"><visual><binding template="ToastGeneric">${texts}</binding></visual></toast>`;
}

// 스크립트를 PowerShell -EncodedCommand가 받는 모양(UTF-16LE → base64)으로 바꾼다
function encodeCommand(code) {
  return Buffer.from(code, 'utf16le').toString('base64');
}

function normalizeKind(kind) {
  return kind === 'window' ? 'window' : 'toast';
}

function toastScript({ title, body }) {
  const xml = buildToastXml({ title, body });
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(${psQuote(xml)})`,
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psQuote(APP_ID)}).Show($toast)`,
  ].join('\n');
}

/*
 * ── 창 부품 ───────────────────────────────────
 * 알림 창과 아침 브리핑 창이 같이 쓰는 PowerShell(WinForms) 조각들.
 * 각 함수는 스크립트 '줄 목록'을 돌려주고, 쓰는 쪽에서 이어 붙여 창 하나를 완성한다.
 * box는 [x, y, 너비, 높이] (창 왼쪽 위 기준 픽셀).
 */
const ps = {
  color: (hex) => `[System.Drawing.ColorTranslator]::FromHtml("${hex}")`,
  font: (size, bold = false) =>
    `New-Object System.Drawing.Font("Malgun Gothic", ${size}${bold ? ', [System.Drawing.FontStyle]::Bold' : ''})`,

  place: (name, [x, y, w, h]) => [
    `$${name}.Location = New-Object System.Drawing.Point(${x}, ${y})`,
    `$${name}.Size = New-Object System.Drawing.Size(${w}, ${h})`,
  ],

  /** 창 뼈대: 가운데, 맨 위 고정, 크기 고정, 남색 바탕. 창 변수 이름은 $f. */
  form: (title, w, h) => [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$f = New-Object System.Windows.Forms.Form',
    `$f.Text = ${psQuote(title)}`,
    `$f.Size = New-Object System.Drawing.Size(${w}, ${h})`,
    '$f.StartPosition = "CenterScreen"',
    '$f.TopMost = $true',
    '$f.FormBorderStyle = "FixedDialog"',
    '$f.MaximizeBox = $false; $f.MinimizeBox = $false',
    `$f.BackColor = ${ps.color(INK)}`,
  ],

  label: (name, text, { color, size, bold, box }) => [
    `$${name} = New-Object System.Windows.Forms.Label`,
    `$${name}.Text = ${psQuote(text)}`,
    `$${name}.ForeColor = ${ps.color(color)}`,
    `$${name}.Font = ${ps.font(size, bold)}`,
    ...ps.place(name, box),
    `$f.Controls.Add($${name})`,
  ],

  /** 버튼. extra에는 누르면 무슨 일이 일어날지 같은 추가 줄을 넣는다. */
  button: (name, text, box, extra = []) => [
    `$${name} = New-Object System.Windows.Forms.Button`,
    `$${name}.Text = ${psQuote(text)}`,
    `$${name}.Font = ${ps.font(10)}`,
    ...ps.place(name, box),
    ...extra,
    `$f.Controls.Add($${name})`,
  ],
};

/** 급한 할일 알림 창: 제목, 본문, [확인] [10분 뒤] 버튼. */
function windowScript({ title, body }) {
  return [
    ...ps.form(trim(title), 460, 240),
    ...ps.label('head', `⏰ ${trim(title)}`, { color: LEMON, size: 13, bold: true, box: [24, 22, 400, 32] }),
    ...ps.label('msg', String(body ?? '').slice(0, 300), { color: CREAM, size: 11, box: [24, 62, 400, 74] }),
    ...ps.button('ok', '확인', [238, 152, 90, 34], ['$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK']),
    '$f.AcceptButton = $ok',
    ...ps.button('snz', SNOOZE_LABEL, [336, 152, 90, 34], ['$snz.DialogResult = [System.Windows.Forms.DialogResult]::Retry']),

    // 잊고 놔둔 창이 영원히 남지 않게 타이머로 닫는다
    '$t = New-Object System.Windows.Forms.Timer',
    `$t.Interval = ${WINDOW_TIMEOUT_MS}`,
    '$t.Add_Tick({ $f.Close() })',
    '$t.Start()',

    '$f.Add_Shown({ $f.Activate() })',
    '$r = $f.ShowDialog()',
    `if ($r -eq [System.Windows.Forms.DialogResult]::Retry) { exit ${EXIT_SNOOZE} }`,
    'exit 0',
  ].join('\n');
}

/**
 * 창이 끝난 결과 → 사용자의 답. 윈도우는 종료 번호, 맥은 osascript가 출력한 버튼 이름으로 안다.
 * X로 닫았거나 시간이 지나 닫힌 경우는 '확인'으로 본다.
 */
function answerFor(code, stdout = '') {
  return code === EXIT_SNOOZE || stdout.trim() === SNOOZE_LABEL ? 'snooze' : 'ok';
}

/*
 * ── 맥 ───────────────────────────────────────
 * 스크립트는 고정된 글이고, 바뀌는 글(제목·본문)은 argv로만 들어간다. 그래서 할일 제목에
 * 따옴표나 명령 같은 글자가 있어도 스크립트가 깨지거나 실행될 일이 없다.
 */
const mac = {
  /** argv: [제목, 본문] */
  toast: [
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    'end run',
  ],
  /** argv: [제목, 본문]. 누른 버튼 이름을 출력한다. */
  window: [
    'on run argv',
    'activate', // 다른 창 뒤에 숨지 않게 앞으로
    `set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"${SNOOZE_LABEL}", "확인"} default button "확인" giving up after ${WINDOW_TIMEOUT_MS / 1000}`,
    'return button returned of r',
    'end run',
  ],
};

/**
 * osascript 실행. 스크립트 줄마다 -e를 붙이고 뒤에 인자를 단다. briefing.js도 이걸 쓴다.
 * '--' 뒤는 옵션으로 읽지 않는다. 이게 없으면 '-e ...'로 시작하는 할일 제목이 스크립트로 실행된다.
 */
function runAppleScript(lines, args = [], options = {}) {
  return spawn('osascript', [...lines.flatMap((l) => ['-e', l]), '--', ...args.map(String)], options);
}

/** 운영체제에 맞는 팝업 프로세스를 띄운다. 띄울 방법이 없으면 null. */
function spawnPopup(mode, { title, body }) {
  if (process.platform === 'win32') {
    const script = mode === 'window' ? windowScript({ title, body }) : toastScript({ title, body });
    return runPowerShell(script, { windowsHide: true, stdio: 'ignore' });
  }
  if (process.platform === 'darwin') {
    const text = mode === 'window' ? `⏰ ${trim(title)}\n\n${String(body ?? '').slice(0, 300)}` : trim(body);
    return runAppleScript(mac[mode], [trim(title), text], { stdio: ['ignore', 'pipe', 'ignore'] });
  }
  return null;
}

/** PowerShell을 창 없이 실행한다. briefing.js도 이걸 쓴다. */
function runPowerShell(script, options = {}) {
  return spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)], options);
}

/**
 * 팝업 하나를 띄우고 사용자가 뭘 눌렀는지 돌려준다.
 * 토스트는 띄우고 바로 'ok'. 창은 닫힐 때까지 기다렸다가 'ok' 또는 'snooze'.
 * 어떤 경우에도 오류를 던지지 않는다. 팝업이 실패해도 서버는 계속 돌아야 하니까.
 */
function show({ kind, title, body }) {
  const mode = normalizeKind(kind);

  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };

    let child;
    try {
      child = spawnPopup(mode, { title, body });
    } catch {
      child = null;
    }
    if (!child) {
      done('ok');
      return;
    }

    let out = '';
    child.stdout?.on('data', (chunk) => (out += chunk));
    child.on('error', () => done('ok'));
    // 'exit'는 출력(맥의 버튼 이름)을 다 읽기 전에 올 수 있어서 'close'를 기다린다
    child.on('close', (code) => done(answerFor(code, out)));

    if (mode === 'window') {
      // 창이 어떤 이유로든 안 닫혀도 서버가 영영 기다리지 않게 (unref: 이 타이머 때문에 프로그램이 안 꺼지는 일 방지)
      const guard = setTimeout(() => done('ok'), WINDOW_TIMEOUT_MS + 30_000);
      if (typeof guard.unref === 'function') guard.unref();
    }
  });
}

module.exports = {
  show,
  answerFor,
  xmlEscape,
  psQuote,
  buildToastXml,
  encodeCommand,
  normalizeKind,
  toastScript,
  windowScript,
  runPowerShell,
  runAppleScript,
  ps,
  mac,
  POWERSHELL,
  APP_ID,
  MAX_TEXT,
  EXIT_SNOOZE,
  SNOOZE_LABEL,
  INK,
  LEMON,
  CREAM,
};
