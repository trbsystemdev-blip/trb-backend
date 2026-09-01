const assert = require('node:assert/strict');
const test = require('node:test');
const {
  validateLiffBankFormInput,
} = require('../lib/snsVideoLiffForm');

test('無料フォームは金融機関・支店の必須入力、口座番号の再入力、名義カナを要求する', () => {
  const valid = validateLiffBankFormInput({
    bankName: 'みずほ銀行', branchName: '東京営業部', accountType: '普通',
    accountNumber: '１２３-４５６７', accountNumberConfirmation: '1234567', accountHolderKana: 'ヤマダ タロウ',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.value.accountNumber, '1234567');
  assert.equal(valid.value.bankName, 'みずほ銀行');

  const invalid = validateLiffBankFormInput({
    bankName: 'みずほ銀行', branchName: '東京営業部', accountType: '普通',
    accountNumber: '1234567', accountNumberConfirmation: '7654321', accountHolderKana: 'ヤマダタロウ',
  });
  assert.deepEqual(invalid, { ok: false, message: '確認用の口座番号が一致しません。' });
});

test('金融機関名・支店名の空欄と長すぎる値を拒否する', () => {
  const missing = validateLiffBankFormInput({
    bankName: '', branchName: '東京営業部', accountType: '普通', accountNumber: '1234567', accountNumberConfirmation: '1234567', accountHolderKana: 'ヤマダタロウ',
  });
  assert.deepEqual(missing, { ok: false, message: '銀行名を1〜100文字で入力してください。' });

  const longBranch = validateLiffBankFormInput({
    bankName: 'みずほ銀行', branchName: 'あ'.repeat(101), accountType: '普通', accountNumber: '1234567', accountNumberConfirmation: '1234567', accountHolderKana: 'ヤマダタロウ',
  });
  assert.deepEqual(longBranch, { ok: false, message: '支店名を1〜100文字で入力してください。' });
});
