'use strict';

const ALLOWED_BANK_ACCOUNT_VIEWERS = Object.freeze(['開発担当', '渡部大輔']);

function normalizeDisclosureRequest(input = {}) {
  const lineUid = String(input.lineUid || '').trim();
  const viewerName = String(input.viewerName || '').trim();
  const purpose = String(input.purpose || '').trim().replace(/\s+/g, ' ');
  const disclosurePassword = String(input.disclosurePassword || '');

  if (!lineUid || lineUid.length > 128) {
    return { ok: false, message: '確認するスタッフを選択してください。' };
  }
  if (!ALLOWED_BANK_ACCOUNT_VIEWERS.includes(viewerName)) {
    return { ok: false, message: '閲覧者を選択してください。' };
  }
  if (purpose.length < 10 || purpose.length > 300) {
    return { ok: false, message: '閲覧理由は10〜300文字で入力してください。' };
  }
  if (!disclosurePassword || disclosurePassword.length > 512) {
    return { ok: false, message: '管理者パスワードを再入力してください。' };
  }
  return { ok: true, value: { lineUid, viewerName, purpose, disclosurePassword } };
}

function passwordMatches(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (suppliedBuffer.length !== expectedBuffer.length) return false;
  return require('crypto').timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function getRequestAuditContext(req) {
  const forwardedFor = String((req && req.headers && req.headers['x-forwarded-for']) || '');
  const ipAddress = (forwardedFor.split(',')[0].trim() || (req && req.socket && req.socket.remoteAddress) || '').slice(0, 100);
  const userAgent = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 500);
  return { ipAddress, userAgent };
}

module.exports = {
  ALLOWED_BANK_ACCOUNT_VIEWERS,
  normalizeDisclosureRequest,
  passwordMatches,
  getRequestAuditContext
};
