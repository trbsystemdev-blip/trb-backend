const crypto = require('crypto');

const BANK_ACCOUNT_STEPS = [
  { key: 'bankName', state: 'BANK_ACCOUNT_BANK_NAME', label: '銀行名', prompt: '【振込先口座登録 1/5】\n銀行名を入力してください。\n例）みずほ銀行' },
  { key: 'branchName', state: 'BANK_ACCOUNT_BRANCH_NAME', label: '支店名', prompt: '【振込先口座登録 2/5】\n支店名を入力してください。\n例）新宿支店' },
  { key: 'accountType', state: 'BANK_ACCOUNT_TYPE', label: '預金種別', prompt: '【振込先口座登録 3/5】\n預金種別を「普通」または「当座」で入力してください。' },
  { key: 'accountNumber', state: 'BANK_ACCOUNT_NUMBER', label: '口座番号', prompt: '【振込先口座登録 4/5】\n口座番号を7桁の数字で入力してください。\n例）1234567' },
  { key: 'accountHolderKana', state: 'BANK_ACCOUNT_HOLDER', label: '名義カナ', prompt: '【振込先口座登録 5/5】\n口座名義をカタカナで入力してください。\n例）ヤマダ タロウ' }
];

function createKey(secret) {
  if (!secret || String(secret).length < 32) throw new Error('BANK_INFO_ENCRYPTION_KEY must be at least 32 characters.');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptText(value, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', createKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

function decryptText(payload, secret) {
  const [ivText, tagText, dataText] = String(payload || '').split('.');
  if (!ivText || !tagText || !dataText) throw new Error('Invalid encrypted payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', createKey(secret), Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8');
}

function encryptObject(value, secret) { return encryptText(JSON.stringify(value || {}), secret); }
function decryptObject(payload, secret) { return JSON.parse(decryptText(payload, secret)); }

function normalizeAccountInput(key, rawValue) {
  const value = String(rawValue || '').trim().replace(/　/g, ' ');
  if (key === 'accountType') {
    if (['普通', '普通預金'].includes(value)) return { ok: true, value: '普通' };
    if (['当座', '当座預金'].includes(value)) return { ok: true, value: '当座' };
    return { ok: false, message: '預金種別は「普通」または「当座」で入力してください。' };
  }
  if (key === 'accountNumber') {
    const digits = value.replace(/[\s\-－ー]/g, '').replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0));
    if (!/^\d{7}$/.test(digits)) return { ok: false, message: '口座番号は7桁の数字で入力してください。例）1234567' };
    return { ok: true, value: digits };
  }
  if (key === 'accountHolderKana') {
    const normalized = value.toUpperCase();
    if (!normalized || normalized.length > 100 || !/^[ァ-ヶー\s 0-9Ａ-Ｚ・．－\-]+$/.test(normalized)) {
      return { ok: false, message: '口座名義はカタカナで1〜100文字で入力してください。例）ヤマダ タロウ' };
    }
    return { ok: true, value: normalized.replace(/\s+/g, ' ') };
  }
  if (!value || value.length > 100) return { ok: false, message: `${key === 'bankName' ? '銀行名' : '支店名'}を1〜100文字で入力してください。` };
  return { ok: true, value };
}

function maskAccountNumber(value) {
  const text = String(value || '');
  return text.length >= 4 ? `****${text.slice(-4)}` : '****';
}

function maskHolderKana(value) {
  const text = String(value || '');
  return text.length > 2 ? `${text.slice(0, 2)}…` : text;
}

function looksLikeBankInfoMessage(value) {
  const text = String(value || '');
  return /(銀行名|支店名|口座番号|口座名義|名義カナ|普通預金|当座預金|[0-9０-９][0-9０-９\s\-－ー]{6,})/u.test(text);
}

module.exports = {
  BANK_ACCOUNT_STEPS,
  encryptText,
  decryptText,
  encryptObject,
  decryptObject,
  normalizeAccountInput,
  maskAccountNumber,
  maskHolderKana,
  looksLikeBankInfoMessage
};
