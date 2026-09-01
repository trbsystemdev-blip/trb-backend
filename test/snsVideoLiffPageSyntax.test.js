const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('SNS動画施策のLIFF口座登録フォームには必要な入力・確認・送信導線がある', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/sns-video-bank.html'), 'utf8');
  assert.match(html, /id="bankName"/);
  assert.match(html, /id="branchName"/);
  assert.match(html, /id="accountNumberConfirmation"/);
  assert.match(html, /api\/sns-video\/liff-account/);
  assert.match(html, /liff\.getIDToken\(\)/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.doesNotMatch(html, /api\/sns-video\/banks|KENALL_API_KEY/);

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  new Function(scripts[0]);
});
