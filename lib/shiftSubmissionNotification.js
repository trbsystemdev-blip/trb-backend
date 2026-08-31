const crypto = require('crypto');

function monthLabel(date) {
  const matched = String(date || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!matched) throw new Error('シフト希望の日付形式が正しくありません。');
  return `${matched[1]}年${Number(matched[2])}月`;
}

function buildShiftSubmissionNotification(lineUid, entries) {
  if (!lineUid || !Array.isArray(entries) || entries.length === 0) {
    throw new Error('シフト希望通知に必要な情報が不足しています。');
  }
  const normalized = entries.map((entry) => ({
    date: String(entry.date || ''),
    type: String(entry.type || ''),
    startTime: entry.startTime || null,
    endTime: entry.endTime || null
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'ja'));
  const targetMonths = [...new Set(normalized.map((entry) => monthLabel(entry.date)))];
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({ lineUid, entries: normalized }))
    .digest('hex');

  return {
    submissionKey: `shift:${fingerprint}`,
    targetMonths,
    entryCount: normalized.length
  };
}

module.exports = { buildShiftSubmissionNotification };
