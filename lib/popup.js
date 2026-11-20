'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 윈도우 화면에 알림을 띄운다. 외부 패키지 없이 하려고 PowerShell을 빌려 쓴다.
 * Node가 PowerShell 스크립트를 글로 만들어서 PowerShell에게 실행시키는 방식이다.
 *   - 토스트: 화면 오른쪽 아래에 뜨고 알림 센터에 남는 윈도우 표준 알림 (보통·천천히 할일)
 *   - 창    : 화면 가운데에 뜨고 버튼을 누를 때까지 남는 창 (급한 할일, 아침 브리핑)
 *
 * 함정 두 가지:
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
    ...ps.button('snz', '10분 뒤', [336, 152, 90, 34], ['$snz.DialogResult = [System.Windows.Forms.DialogResult]::Retry']),

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

/** 창이 끝난 번호 → 사용자의 답. X로 닫았거나 강제로 꺼진 경우(1, null)는 '확인'으로 본다. */
function answerFor(code) {
  return code === EXIT_SNOOZE ? 'snooze' : 'ok';
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
  const script = mode === 'window' ? windowScript({ title, body }) : toastScript({ title, body });

  return new Promise((resolve) => {
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };

    let child;
    try {
      child = runPowerShell(script, { windowsHide: true, stdio: 'ignore' });
    } catch {
      done('ok');
      return;
    }

    child.on('error', () => done('ok'));
    child.on('exit', (code) => done(answerFor(code)));

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
  ps,
  POWERSHELL,
  APP_ID,
  MAX_TEXT,
  EXIT_SNOOZE,
  INK,
  LEMON,
  CREAM,
};
