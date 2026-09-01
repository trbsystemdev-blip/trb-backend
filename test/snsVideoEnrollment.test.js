const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encryptObject, decryptObject, normalizeAccountInput, maskAccountNumber, maskHolderKana, looksLikeBankInfoMessage
} = require('../lib/snsVideoEnrollment');

const secret = 'test-only-bank-info-encryption-secret-with-32-chars';

test('口座情報を暗号化して復号できる', () => {
  const original = { bankName: 'みずほ銀行', accountNumber: '1234567' };
  const encrypted = encryptObject(original, secret);
  assert.notEqual(encrypted, JSON.stringify(original));
  assert.deepEqual(decryptObject(encrypted, secret), original);
});

test('口座番号は全角・ハイフンを正規化し、7桁だけ受け付ける', () => {
  assert.deepEqual(normalizeAccountInput('accountNumber', '１２３-４５６７'), { ok: true, value: '1234567' });
  assert.equal(normalizeAccountInput('accountNumber', '1234').ok, false);
});

test('預金種別と名義カナを検証し、管理画面用にマスキングする', () => {
  assert.deepEqual(normalizeAccountInput('accountType', '普通預金'), { ok: true, value: '普通' });
  assert.equal(normalizeAccountInput('accountHolderKana', 'YAMADA TARO').ok, false);
  assert.equal(maskAccountNumber('1234567'), '****4567');
  assert.equal(maskHolderKana('ヤマダ タロウ'), 'ヤマ…');
});

test('まとめて送られた可能性のある口座情報を順番入力へ誘導できる', () => {
  assert.equal(looksLikeBankInfoMessage('銀行名：みずほ銀行\n支店名：新宿支店\n口座番号：1234567'), true);
  assert.equal(looksLikeBankInfoMessage('みずほ 新宿 普通 1234567 ヤマダタロウ'), true);
  assert.equal(looksLikeBankInfoMessage('日報を提出しました'), false);
});
