const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('SNS動画施策タブの管理画面スクリプトが構文として読み込める', () => {
  const adminHtml = fs.readFileSync(path.join(__dirname, '../../trb-liff-source/admin.html'), 'utf8');
  assert.match(adminHtml, /tab-sns-video/);
  assert.match(adminHtml, /loadSnsVideoSubmissions/);
  assert.match(adminHtml, /sns-video-submissions/);

  const inlineScripts = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(inlineScripts.length > 0, 'inline script must exist');
  inlineScripts.forEach(script => new Function(script));
});
