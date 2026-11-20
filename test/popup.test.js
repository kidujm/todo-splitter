'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/popup');

/* 할일 제목은 사용자가 아무렇게나 적는다.
   따옴표나 꺾쇠가 섞여도 PowerShell 명령이나 XML이 깨지면 안 된다. */

test('xmlEscape는 XML을 깨뜨리는 글자를 막는다', () => {
  assert.equal(P.xmlEscape('a & b'), 'a &amp; b');
  assert.equal(P.xmlEscape('<script>'), '&lt;script&gt;');
  assert.equal(P.xmlEscape('그가 "말했다"'), '그가 &quot;말했다&quot;');
  assert.equal(P.xmlEscape("it's"), 'it&apos;s');
  assert.equal(P.xmlEscape(null), '');
});

test('psQuote는 작은따옴표를 두 번 써서 막는다', () => {
  assert.equal(P.psQuote("it's"), "'it''s'");
  assert.equal(P.psQuote('보통 글자'), "'보통 글자'");
  // 명령을 끊고 새 명령을 붙이려는 시도가 문자열 안에 갇혀야 한다
  assert.equal(P.psQuote("'; Remove-Item C:\ -Recurse; '"), "'''; Remove-Item C:\ -Recurse; '''");
  assert.equal(P.psQuote(null), "''");
});

test('buildToastXml은 제목과 본문을 이스케이프해서 넣는다', () => {
  const xml = P.buildToastXml({ title: '할일 & 알림', body: '<b>지금</b>' });
  assert.match(xml, /<toast/);
  assert.ok(xml.includes('할일 &amp; 알림'));
  assert.ok(xml.includes('&lt;b&gt;지금&lt;/b&gt;'));
  assert.ok(!xml.includes('<b>'));
});

test('buildToastXml은 줄바꿈을 두 줄로 나눠 담는다', () => {
  const xml = P.buildToastXml({ title: '제목', body: '첫 줄\n둘째 줄' });
  const texts = [...xml.matchAll(/<text>([^<]*)<\/text>/g)].map((m) => m[1]);
  assert.deepEqual(texts, ['제목', '첫 줄', '둘째 줄']);
});

test('아주 긴 제목은 잘라서 넣는다', () => {
  const xml = P.buildToastXml({ title: 'ㄱ'.repeat(500), body: 'ㄴ'.repeat(500) });
  const texts = [...xml.matchAll(/<text>([^<]*)<\/text>/g)].map((m) => m[1]);
  for (const t of texts) assert.ok(t.length <= P.MAX_TEXT, `${t.length} > ${P.MAX_TEXT}`);
});

test('encodeCommand는 PowerShell이 읽는 UTF-16LE base64를 만든다', () => {
  const enc = P.encodeCommand('Write-Output "한글"');
  assert.match(enc, /^[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(enc, 'base64').toString('utf16le'), 'Write-Output "한글"');
});

test('알 수 없는 종류는 토스트로 떨어진다', () => {
  assert.equal(P.normalizeKind('window'), 'window');
  assert.equal(P.normalizeKind('toast'), 'toast');
  assert.equal(P.normalizeKind('엉뚱'), 'toast');
  assert.equal(P.normalizeKind(undefined), 'toast');
});

/* 창 팝업이 돌려주는 종료 코드를 답으로 옮기는 자리.
   PowerShell 쪽은 Retry(10분 뒤) → exit 2, 그 밖 → exit 0 으로 끝난다. */

test('종료 코드 2는 스누즈, 나머지는 확인으로 읽는다', () => {
  assert.equal(P.answerFor(2), 'snooze');
  assert.equal(P.answerFor(0), 'ok');
  assert.equal(P.answerFor(1), 'ok');
  // 창을 X로 닫거나(1) 강제 종료되어도(null) 알림을 미루지는 않는다
  assert.equal(P.answerFor(null), 'ok');
  assert.equal(P.answerFor(undefined), 'ok');
});

test('EXIT_SNOOZE 상수와 생성 스크립트가 어긋나지 않는다', () => {
  const script = P.windowScript({ title: 't', body: 'b' });
  assert.ok(script.includes(`exit ${P.EXIT_SNOOZE}`), '스크립트의 exit 코드가 상수와 다르다');
  assert.equal(P.answerFor(P.EXIT_SNOOZE), 'snooze');
});

test('psQuote는 둥근 작은따옴표도 두 번 써서 막는다', () => {
  assert.equal(P.psQuote('a’; Write-Output X; ’'), "'a’’; Write-Output X; ’’'");
});
