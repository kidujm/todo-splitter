'use strict';

/*
 * ── 이 파일이 하는 일 ─────────────────────────────
 * 프로그램의 시작점. `node server.js`로 켜면:
 *   1) 이 PC 안에서만 열리는 웹 서버를 띄운다 (http://localhost:4321)
 *   2) 브라우저가 화면 파일(public/)을 받아 가고, 화면은 /api/... 주소로 데이터를 주고받는다
 *   3) 알림 시계(notifier)를 돌린다
 *
 * 화면(브라우저)과 서버의 역할 나누기:
 *   화면  보여 주기, 클릭 받기 (public/app.js)
 *   서버  파일 저장, claude 실행, 알림 팝업처럼 브라우저가 직접 못 하는 일
 *
 * 외부 패키지(Express 등) 없이 Node에 들어 있는 http 모듈만 쓴다.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const store = require('./lib/store');
const splitter = require('./lib/splitter');
const worklog = require('./lib/worklog');
const notifier = require('./lib/notifier');
const popup = require('./lib/popup');
const { todayStr, isDateStr } = require('./lib/filters');
const game = require('./lib/game');

const PUBLIC_DIR = path.join(__dirname, 'public');
const START_PORT = Number(process.env.PORT) || 4321;
const MAX_BODY = 1_000_000; // 요청 크기 상한 1MB. 할일 1000개도 넉넉하다.

// 파일 확장자 → 브라우저에 알려 줄 파일 종류(MIME). 이걸 틀리게 주면 브라우저가 CSS·JS를 안 읽는다.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 'Cache-Control: no-store' = 브라우저야 저장해 두지 말고 매번 새로 받아라. 코드를 고치면 바로 반영되게.
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 요청 본문(JSON)을 끝까지 받아서 객체로 바꾼다. 데이터는 조각(chunk)으로 나눠 도착해서 모아야 한다. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(new Error('보낸 데이터가 너무 큽니다.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('잘못된 형식의 요청입니다.'));
      }
    });
    req.on('error', reject);
  });
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/**
 * 화면 파일 보내기. '/'는 index.html로.
 * '/../data/todos.json' 같은 주소로 public 폴더 바깥 파일을 빼 가지 못하게 막는다(경로 탈출 방지).
 */
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('403');
    return;
  }
  sendFile(res, file);
}

/*
 * ── 외부 웹페이지 허용 목록 ─────────────────────
 * 다른 곳에 올린 웹페이지가 이 PC의 claude로 쪼개기를 부를 수 있게 하는 설정.
 * 주소는 저장소에 올리지 않는 config.local.json의 allowedOrigins에 적는다.
 * 파일이 없으면 아무 곳도 허용하지 않는다(안전한 쪽이 기본값).
 */
const LOCAL_CONFIG = path.join(__dirname, 'config.local.json');

function loadSiteOrigins() {
  if (!fs.existsSync(LOCAL_CONFIG)) return [];
  try {
    const { allowedOrigins } = JSON.parse(fs.readFileSync(LOCAL_CONFIG, 'utf8'));
    // 'https://주소' 모양만 받는다. 뒤에 경로가 붙거나 http면 버린다.
    return Array.isArray(allowedOrigins) ? allowedOrigins.filter((o) => /^https:\/\/[^/]+$/.test(o)) : [];
  } catch (err) {
    console.error(`config.local.json을 읽지 못해 외부 웹페이지를 막아 둡니다: ${err.message}`);
    return [];
  }
}

const SITE_ORIGINS = new Set(loadSiteOrigins());

/** 외부 웹페이지에 열어 주는 주소는 이 둘뿐. 할일 목록 같은 개인 데이터는 열지 않는다. */
const SITE_ROUTES = new Set(['GET /api/health', 'POST /api/split']);

/** lib 폴더 파일 중 브라우저에도 그대로 내려주는 것. 날짜·XP 규칙을 서버와 화면이 같이 쓰려고. */
const SHARED_LIBS = new Set(['/filters.js', '/game.js']);

/*
 * ── API 주소표 ─────────────────────────────────
 * '방식 주소' → 처리 함수. 화면이 fetch('/api/todos', { method: 'PUT' })를 보내면
 * 'PUT /api/todos' 함수가 실행되고, 돌려준 객체가 JSON으로 화면에 간다.
 *   GET  = 가져오기    PUT = 통째로 바꾸기    POST = 무언가 해 달라고 요청하기
 */
const routes = {
  // 화면을 처음 열 때: 할일 목록, XP 장부, 오늘 날짜, claude를 찾았는지
  'GET /api/todos': async () => {
    const todos = store.load();
    return {
      todos,
      game: store.loadGame(todos),
      today: todayStr(),
      claudeReady: splitter.foundBinary(),
    };
  },

  // 화면이 뭔가 바꿀 때마다 목록 전체를 보내 덮어쓴다.
  // - 알림이 '울렸음' 표시는 서버가 관리하니까 서버 값을 되살려서 저장한다 (notifier.preserveSent 설명 참고)
  // - XP는 화면이 보낸 숫자를 믿지 않고, 저장된 목록을 보고 서버가 다시 계산한다
  'PUT /api/todos': async (body) => {
    const before = store.load();
    const ledger = store.loadGame(before);
    const todos = store.save(notifier.preserveSent(body.todos, before));
    return { todos, game: store.saveGame(game.apply(ledger, todos).game) };
  },

  'POST /api/split': async (body) => {
    const { subtasks } = await splitter.split({ title: body.title, note: body.note });
    return { subtasks };
  },

  // 외부 웹페이지가 쪼개기 전에 "이 PC에 서버가 켜져 있나, claude를 쓸 수 있나" 먼저 물어보는 곳
  'GET /api/health': async () => ({ ok: true, claudeReady: splitter.foundBinary() }),

  'POST /api/worklog/preview': async (body) => {
    const date = dateOf(body);
    return { date, markdown: worklog.buildMarkdown(store.load(), date) };
  },

  'POST /api/worklog/save': async (body) => worklog.saveToDaily(store.load(), dateOf(body)),
};

// 업무일지 날짜. 파일 이름에 쓰이니 'YYYY-MM-DD' 모양이 아니면 받지 않는다(이상한 경로 방지).
function dateOf(body) {
  if (body.date == null) return todayStr();
  if (!isDateStr(body.date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  return body.date;
}

/*
 * 주소창의 호스트 이름이 localhost·127.0.0.1일 때만 받는다.
 * 'DNS 리바인딩'이라는 공격은 남의 도메인 이름이 내 PC(127.0.0.1)를 가리키게 바꿔서,
 * 브라우저가 "같은 사이트"라고 착각한 채 이 서버의 할일 목록을 읽게 만든다.
 * 그때 요청의 Host 칸에는 그 남의 도메인이 찍히므로 여기서 걸러진다.
 */
function isLocalHost(host) {
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host || '');
}

/** 이 서버가 띄운 화면(localhost·127.0.0.1, 포트는 무엇이든)에서 온 요청인지. */
function isLocalOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/*
 * ── 다른 웹사이트에서 온 요청 막기 (CORS) ──────────
 * 브라우저는 A 사이트의 코드가 B 서버로 요청을 보낼 때 'Origin: A 주소'를 붙인다.
 * 이걸 안 막으면, 내가 아무 웹사이트나 열어 둔 사이에 그 사이트 코드가 몰래
 * localhost:4321로 요청을 보내 내 할일을 덮어쓰거나 claude를 실행시킬 수 있다.
 *
 * 그래서: Origin이 없거나(같은 화면) localhost면 통과, 허용 목록에 있고 허용된 주소면 통과, 나머지는 403.
 * 다른 사이트의 요청은 브라우저가 진짜 요청 전에 OPTIONS로 "보내도 돼?"를 먼저 묻는다(사전 확인).
 *
 * 여기서 응답까지 끝냈으면 true를 돌려준다.
 */
function guardOrigin(req, res, urlPath) {
  const origin = req.headers.origin;
  if (!origin || isLocalOrigin(origin)) return false;

  const method = req.method === 'OPTIONS' ? req.headers['access-control-request-method'] : req.method;
  if (!SITE_ORIGINS.has(origin) || !SITE_ROUTES.has(`${method} ${urlPath}`)) {
    sendJson(res, 403, { error: '허용되지 않은 곳에서 온 요청입니다.' });
    return true;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  if (req.method !== 'OPTIONS') return false;

  // 사전 확인에 대한 답: "그 방식·헤더로 보내도 된다. 10분 동안은 다시 안 물어봐도 된다."
  // Private-Network: 공개 사이트가 내 PC(localhost)를 부르는 걸 크롬이 따로 허락받게 해서 붙인다.
  res.writeHead(204, {
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  });
  res.end();
  return true;
}

// 주소 속 %20 같은 글자를 원래 글자로. '/%' 처럼 잘못된 주소는 null (그냥 두면 오류로 서버가 멈춘다).
function decodePath(url) {
  try {
    return decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    return null;
  }
}

// 모든 요청이 여기로 들어온다: 출입 확인 → API면 처리 함수 → 아니면 파일 보내기
const server = http.createServer(async (req, res) => {
  if (!isLocalHost(req.headers.host)) return sendJson(res, 403, { error: '이 PC에서만 열 수 있습니다.' });
  const urlPath = decodePath(req.url);
  if (urlPath === null) return sendJson(res, 400, { error: '잘못된 주소입니다.' });
  if (guardOrigin(req, res, urlPath)) return;

  const handler = routes[`${req.method} ${urlPath}`];
  if (!handler) {
    if (req.method === 'GET' && SHARED_LIBS.has(urlPath)) return sendFile(res, path.join(__dirname, 'lib', urlPath.slice(1)));
    if (req.method === 'GET') return serveStatic(res, urlPath);
    return sendJson(res, 404, { error: '없는 주소입니다.' });
  }

  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    sendJson(res, 200, await handler(body));
  } catch (err) {
    // 처리 중 오류는 서버를 멈추지 않고 화면에 메시지로 돌려준다
    sendJson(res, 400, { error: err.message || '알 수 없는 오류가 발생했습니다.' });
  }
});

// 운영체제마다 '기본 브라우저로 열기' 명령이 다르다. 환경변수 NO_OPEN이 있으면 안 연다(자동 실행용).
function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* 브라우저를 못 열어도 서버는 계속 돈다 */
  }
}

/**
 * 서버 켜기. 포트가 이미 쓰이고 있으면(EADDRINUSE) 다음 번호로 최대 10번 더 시도한다.
 * '127.0.0.1'에만 붙이므로 같은 와이파이의 다른 기기에서도 접속할 수 없다.
 */
function listen(port, attemptsLeft = 10) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listen(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`서버를 시작하지 못했습니다: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  ┌──────────────────────────────────┐');
    console.log('  │   할일 쪼개기  ·  실행 중         │');
    console.log('  └──────────────────────────────────┘');
    console.log(`  주소   ${url}`);
    console.log(`  저장   ${store.FILE}`);
    console.log(`  종료   이 창에서 Ctrl+C`);
    console.log(`  알림   켜짐 (${notifier.TICK_MS / 1000}초마다 확인)`);
    console.log('');
    openBrowser(url);

    notifier.start({
      store,
      popup,
      onError: (err) => console.error(`알림을 띄우지 못했습니다: ${err.message}`),
    });
  });
}

// `node server.js`로 직접 켰을 때만 서버를 띄운다. 테스트가 require로 불러올 때는 안 띄운다.
if (require.main === module) listen(START_PORT);

module.exports = { server, listen, SITE_ORIGINS };
