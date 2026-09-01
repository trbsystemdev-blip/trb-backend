const { normalizeAccountInput } = require('./snsVideoEnrollment');

function validateLiffBankFormInput(input) {
  const bankName = normalizeAccountInput('bankName', input && input.bankName);
  const branchName = normalizeAccountInput('branchName', input && input.branchName);
  const accountType = normalizeAccountInput('accountType', input && input.accountType);
  const accountNumber = normalizeAccountInput('accountNumber', input && input.accountNumber);
  const accountHolderKana = normalizeAccountInput('accountHolderKana', input && input.accountHolderKana);
  const confirmation = normalizeAccountInput('accountNumber', input && input.accountNumberConfirmation);

  if (!bankName.ok) return bankName;
  if (!branchName.ok) return branchName;
  if (!accountType.ok) return accountType;
  if (!accountNumber.ok) return accountNumber;
  if (!accountHolderKana.ok) return accountHolderKana;
  if (!confirmation.ok || confirmation.value !== accountNumber.value) {
    return { ok: false, message: '確認用の口座番号が一致しません。' };
  }
  return {
    ok: true,
    value: {
      bankName: bankName.value,
      branchName: branchName.value,
      accountType: accountType.value,
      accountNumber: accountNumber.value,
      accountHolderKana: accountHolderKana.value,
    }
  };
}

module.exports = {
  validateLiffBankFormInput,
};
