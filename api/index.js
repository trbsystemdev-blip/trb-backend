const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { format } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-password']
}));
app.use(express.json());
app.use(express.text({ type: 'text/plain' }));

// text/plainで送られたJSONをパースするミドルウェア
app.use((req, res, next) => {
  if (req.headers['content-type'] === 'text/plain' && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {}
  }
  next();
});

// --- 定数 ---
const BREAK_MINUTES = 60;
const BREAK_THRESHOLD_MINUTES = 360; // 6時間超のみ休憩控除

// 実稼働時間計算：6時間以下は休憩控除なし、6時間超は60分控除
function calcWorkMin(totalMin) {
  if (totalMin <= BREAK_THRESHOLD_MINUTES) return Math.max(0, totalMin);
  return Math.max(0, totalMin - BREAK_MINUTES);
}
const ROUND_MINUTES = 30;

// ymパラメータのパース（"202606" または "2026-06" 両方対応）
function parseYm(ym) {
  if (!ym) return null;
  const clean = ym.replace(/-/g, ''); // ハイフン除去
  if (clean.length !== 6) return null;
  const year = clean.substring(0, 4);
  const month = clean.substring(4, 6);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
  return { year, month, startDate, endDate };
}
const LATE_PENALTY = -500;
const RAIN_ALLOWANCE = 3000;
const TRANSPORT_FEE = 500;

// --- 環境変数 ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // Service Role Key推奨
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// --- Supabase クライアント ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- ユーザー情報管理 ---
async function getUserInfo(uid) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('line_uid', uid)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 is "No rows found"
    console.error('getUserInfo error:', error);
  }
  
  if (data) {
    return {
      id: data.id,
      name: data.name || uid,
      role: data.role || 'メインドライバー',
      hourlyWage: data.hourly_wage || 0,
      state: data.state || '',
      stateData: data.state_data || {}
    };
  }
  return null;
}

async function ensureUserExists(uid) {
  const user = await getUserInfo(uid);
  if (!user) {
    const { error } = await supabase
      .from('users')
      .insert([{
        line_uid: uid,
        name: '',
        role: 'メインドライバー',
        hourly_wage: 0,
        state: ''
      }]);
    if (error) console.error('ensureUserExists error:', error);
  }
}

async function setUserState(uid, state, stateData = {}) {
  await ensureUserExists(uid);
  const { error } = await supabase
    .from('users')
    .update({ state: state, state_data: stateData })
    .eq('line_uid', uid);
  if (error) console.error('setUserState error:', error);
}

// --- 勤怠打刻ロジック ---
// 出勤：切り上げ（遅刻側負担）例 08:46 → 09:00
// 退勤：切り上げ（スタッフ有利）例 17:14 → 17:30
function roundTime(dateObj, isClockIn) {
  const minutes = dateObj.getMinutes();
  const rounded = new Date(dateObj);
  const mod = minutes % ROUND_MINUTES;
  if (mod === 0) return rounded; // ちょうどの場合はそのまま
  if (isClockIn) {
    // 出勤は切り上げ（遅刻側負担：08:46→09:00）
    rounded.setMinutes(minutes + (ROUND_MINUTES - mod), 0, 0);
  } else {
    // 退勤は切り捨て（早退側負担：18:16→18:00）
    rounded.setMinutes(minutes - mod, 0, 0);
  }
  return rounded;
}

async function findTodayAttendance(uid) {
  const today = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .eq('line_uid', uid)
    .eq('date', today)
    .single();
    
  if (error && error.code !== 'PGRST116') console.error('findTodayAttendance error:', error);
  return data;
}

async function handleLocation(uid, lat, lng, replyToken) {
  try {
    await ensureUserExists(uid);
    const user = await getUserInfo(uid);
    const gps = `${lat},${lng}`;
    const now = toZonedTime(new Date(), 'Asia/Tokyo');
    const todayStr = format(now, 'yyyy-MM-dd');
    const record = await findTodayAttendance(uid);

    if (!record) {
      // 出勤
      const roundedIn = roundTime(now, true);
      const timeStr = format(roundedIn, 'HH:mm');
      const actualStr = format(now, 'HH:mm');

      const { error } = await supabase
        .from('attendance')
        .insert([{
          line_uid: uid,
          date: todayStr,
          clock_in: timeStr,
          clock_in_raw: actualStr,
          break_minutes: BREAK_MINUTES,
          transportation: TRANSPORT_FEE,
          gps: gps
        }]);
      
      if (error) console.error('Clock in error:', error);

      let msg = `《出勤》${user.name}さん\n打刻時刻：${actualStr}`;
      if (actualStr !== timeStr) msg += `\n見なし時刻：${timeStr}（前後${ROUND_MINUTES}分見なし）`;
      msg += `\n交通費：${TRANSPORT_FEE}円 ✅`;
      await replyToUser(replyToken, msg);

    } else if (record.reserve_only) {
      await replyToUser(replyToken, '本日はリザーブ手当のみの申請日として登録されています。出勤・退勤の打刻はできません。勤務することになった場合は、管理者に連絡してください。');

    } else if (!record.clock_out) {
      // 退勤
      const roundedOut = roundTime(now, false);
      const timeStr = format(roundedOut, 'HH:mm');
      const actualStr = format(now, 'HH:mm');

      // time型（HH:mm:ss）の場合も対応するため先頭5文字（HH:mm）のみ使用
      const inTime = record.clock_in ? record.clock_in.substring(0, 5) : null;
      let workMin = 0;
      let pay = 0;
      let totalMin = 0;

      if (inTime) {
        const inDate = new Date(`${todayStr}T${inTime}:00+09:00`);
        const outDate = new Date(`${todayStr}T${timeStr}:00+09:00`);
        totalMin = Math.round((outDate - inDate) / 60000);
        workMin = calcWorkMin(totalMin);

        const hourlyWage = user.hourlyWage || 0;
        const basePay = Math.round((workMin / 60) * hourlyWage);
        const penalty = record.penalty || 0;
        const rainAllowance = record.rain_allowance || 0;
        const transport = record.transportation || TRANSPORT_FEE;
        pay = basePay + penalty + rainAllowance + transport;
      }

      const { error } = await supabase
        .from('attendance')
        .update({
          clock_out: timeStr,
          clock_out_raw: actualStr,
          work_minutes: workMin
        })
        .eq('id', record.id);
        
      if (error) console.error('Clock out error:', error);

      const workH = Math.floor(workMin / 60);
      const workM = workMin % 60;
      const breakNote = totalMin > BREAK_THRESHOLD_MINUTES ? '（休憩１時間自動控除）' : '（休憩控除なし）';
      let msg = `《退勤》${user.name}さん\n打刻時刻：${actualStr}`;
      if (actualStr !== timeStr) msg += `\n見なし時刻：${timeStr}（切り捨て）`;
      msg += `\n実労働：${workH}時間${workM}分${breakNote}`;
      if (user.hourlyWage > 0) msg += `\n本日の給与目安：${pay.toLocaleString()}円`;
      msg += `\n\n退勤しました。「日報」ボタンから日報を入力してください。`;
      await replyToUser(replyToken, msg);

    } else {
      await replyToUser(replyToken, `${user.name}さん、本日の出退勤はすでに記録されています。`);
    }
  } catch (err) {
    console.error('handleLocation error:', err);
  }
}

// --- 日報フロー（インメモリキャッシュ） ---
const tempCache = {};

// --- 経費管理（共通の車内経費袋1袋） ---
const EXPENSE_RECEIPT_BUCKET = 'expense-receipts';

async function getExpenseSettings() {
  const { data, error } = await supabase
    .from('expense_settings')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) {
    console.error('getExpenseSettings error:', error);
    return null;
  }
  return data;
}

async function ensureExpenseAlertRecipient(settings) {
  if (!settings || settings.alert_line_uid) return settings;
  // 渡部大輔さんを初期通知先として自動設定する。見つからない場合は管理画面で設定する。
  const { data: users } = await supabase
    .from('users')
    .select('line_uid')
    .ilike('name', '%渡部大輔%')
    .limit(1);
  if (users && users[0]) {
    const { data } = await supabase
      .from('expense_settings')
      .update({ alert_line_uid: users[0].line_uid, updated_at: new Date().toISOString() })
      .eq('id', 1)
      .select()
      .single();
    return data || settings;
  }
  return settings;
}

async function calculateExpenseBalance() {
  let settings = await getExpenseSettings();
  settings = await ensureExpenseAlertRecipient(settings);
  if (!settings) return { balance: null, settings: null, totals: null };

  const { data: rows, error } = await supabase
    .from('expenses')
    .select('transaction_type, amount');
  if (error) {
    console.error('calculateExpenseBalance error:', error);
    return { balance: null, settings, totals: null };
  }

  const totals = { expense: 0, replenishment: 0, loss: 0 };
  (rows || []).forEach(row => {
    if (Object.prototype.hasOwnProperty.call(totals, row.transaction_type)) {
      totals[row.transaction_type] += Number(row.amount) || 0;
    }
  });
  const balance = Number(settings.opening_balance || 0) + totals.replenishment - totals.expense - totals.loss;
  return { balance, settings, totals };
}

async function updateLowBalanceAlert() {
  const result = await calculateExpenseBalance();
  const { balance, settings } = result;
  if (balance === null || !settings) return result;

  const isLow = balance < Number(settings.low_balance_threshold || 0);
  if (isLow && !settings.is_low_balance_alerted && settings.alert_line_uid) {
    await pushToUser(settings.alert_line_uid,
      `【経費袋 残高アラート】\n現在残高：${balance.toLocaleString()}円\nアラート基準：${Number(settings.low_balance_threshold || 0).toLocaleString()}円未満\n経費管理タブで内容を確認し、必要に応じて補充を登録してください。`);
    await supabase.from('expense_settings')
      .update({ is_low_balance_alerted: true, updated_at: new Date().toISOString() })
      .eq('id', 1);
  } else if (!isLow && settings.is_low_balance_alerted) {
    // 補充により閾値以上へ戻ったら、次の残高低下時に再通知できるようにする。
    await supabase.from('expense_settings')
      .update({ is_low_balance_alerted: false, updated_at: new Date().toISOString() })
      .eq('id', 1);
  }
  return result;
}

async function addExpenseTransaction({ transactionType, amount, purpose, receiptPath = null, reportedBy = null, note = null }) {
  const { data, error } = await supabase
    .from('expenses')
    .insert([{
      transaction_date: format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd'),
      transaction_type: transactionType,
      amount: amount,
      purpose: purpose,
      receipt_path: receiptPath,
      reported_by: reportedBy,
      note: note
    }])
    .select()
    .single();
  if (error) {
    console.error('addExpenseTransaction error:', error);
    return { data: null, error };
  }
  const balanceResult = await updateLowBalanceAlert();
  return { data, error: null, balance: balanceResult.balance };
}

async function startExpenseFlow(uid, replyToken) {
  await setUserState(uid, 'EXPENSE_AMOUNT', { transactionType: 'expense' });
  await replyToUser(replyToken, '【経費報告】\n使用した金額を数字で入力してください。\n例）1280\n\n※現金を補充する場合は、管理画面の「経費管理」タブから登録してください。');
}

async function handleExpenseFlow(uid, text, replyToken) {
  const user = await getUserInfo(uid);
  const state = user ? user.state : '';
  const data = user && user.stateData ? user.stateData : {};

  if (state === 'EXPENSE_AMOUNT') {
    const normalized = String(text).replace(/[，,円\s]/g, '');
    const amount = Number(normalized);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1000000) {
      await replyToUser(replyToken, '金額は1円以上1,000,000円以下の数字で入力してください。\n例）1280');
      return;
    }
    await setUserState(uid, 'EXPENSE_PURPOSE', { ...data, amount });
    await replyToUser(replyToken, '用途を入力してください。\n例）自転車用チェーンオイル');
    return;
  }

  if (state === 'EXPENSE_PURPOSE') {
    const purpose = String(text || '').trim();
    if (!purpose || purpose.length > 200) {
      await replyToUser(replyToken, '用途を1〜200文字で入力してください。');
      return;
    }
    await setUserState(uid, 'EXPENSE_RECEIPT', { ...data, purpose });
    await replyToUser(replyToken, 'レシート写真をこのまま1枚送信してください。\nレシートがない場合は「レシートなし」と送信してください。');
    return;
  }

  if (state === 'EXPENSE_RECEIPT') {
    if (text !== 'レシートなし' && text !== 'なし') {
      await replyToUser(replyToken, 'レシート写真を送信するか、「レシートなし」と入力してください。');
      return;
    }
    const result = await addExpenseTransaction({
      transactionType: 'expense',
      amount: Number(data.amount),
      purpose: data.purpose,
      reportedBy: uid,
      note: 'レシートなし'
    });
    if (result.error) {
      await replyToUser(replyToken, '経費報告の保存中にエラーが発生しました。管理者に連絡してください。');
      return;
    }
    await setUserState(uid, '');
    await replyToUser(replyToken, `【経費報告を登録しました】\n金額：${Number(data.amount).toLocaleString()}円\n用途：${data.purpose}\nレシート：なし\n経費袋残高：${Number(result.balance).toLocaleString()}円`);
  }
}

async function handleExpenseReceiptImage(uid, messageId, replyToken) {
  const user = await getUserInfo(uid);
  if (!user || user.state !== 'EXPENSE_RECEIPT') {
    await replyToUser(replyToken, 'レシート写真は「経費報告」の入力途中に送信してください。');
    return;
  }
  const data = user.stateData || {};
  try {
    const content = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      responseType: 'arraybuffer',
      headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    const contentType = String(content.headers['content-type'] || 'image/jpeg').toLowerCase();
    const ext = contentType.includes('png') ? 'png' : (contentType.includes('webp') ? 'webp' : 'jpg');
    const datePart = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM');
    const path = `${datePart}/${uid}/${messageId}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(EXPENSE_RECEIPT_BUCKET)
      .upload(path, Buffer.from(content.data), { contentType, upsert: false });
    if (uploadError) throw uploadError;

    const result = await addExpenseTransaction({
      transactionType: 'expense',
      amount: Number(data.amount),
      purpose: data.purpose,
      receiptPath: path,
      reportedBy: uid
    });
    if (result.error) throw result.error;

    await setUserState(uid, '');
    await replyToUser(replyToken, `【経費報告を登録しました】\n金額：${Number(data.amount).toLocaleString()}円\n用途：${data.purpose}\nレシート：保存済み\n経費袋残高：${Number(result.balance).toLocaleString()}円`);
  } catch (err) {
    console.error('handleExpenseReceiptImage error:', err.response ? err.response.data : err.message);
    await replyToUser(replyToken, 'レシート写真の保存中にエラーが発生しました。もう一度送信するか、管理者に連絡してください。');
  }
}

async function handleTextMessage(uid, text, replyToken) {
  await ensureUserExists(uid);
  const user = await getUserInfo(uid);
  const state = user ? user.state : '';

  // どのフロー中でも「キャンセル」でリセットできる
  if (text === 'キャンセル' || text === 'cancel') {
    await setUserState(uid, '');
    await replyToUser(replyToken, '操作をキャンセルしました。メニューから操作してください。');
    return;
  }

  if (state && state.startsWith('EXPENSE_')) {
    await handleExpenseFlow(uid, text, replyToken);
    return;
  }

  if (state && state.startsWith('CLOCK_IN_REASON:')) {
    await handleClockInRequest(uid, state.substring('CLOCK_IN_REASON:'.length), replyToken, text);
    return;
  }

  if (state && state.startsWith('CLOCK_OUT_REASON:')) {
    await handleClockOutRequest(uid, state.substring('CLOCK_OUT_REASON:'.length), replyToken, text);
    return;
  }

  if (state && state.startsWith('REPORT_')) {
    await handleReportFlow(uid, text, replyToken);
    return;
  }

  if (state === 'REGISTER_NAME') {
    await handleRegisterName(uid, text, replyToken);
    return;
  }

  if (state === 'REGISTER_WAGE') {
    await handleRegisterWage(uid, text, replyToken);
    return;
  }

  if (state === 'REGISTER_ROLE') {
    await handleRegisterRole(uid, text, replyToken);
    return;
  }

  if (text === '経費報告' || text === '経費申請') {
    await startExpenseFlow(uid, replyToken);
    return;
  }

  if (text === 'リザーブ申請' || text === '雨天補償申請') {
    const record = await findTodayAttendance(uid);

    // リザーブ手当は、業務中止日に出勤せず単独で申請できる。
    // 出勤済みの勤務日には誤って重複申請しないよう、管理者確認を案内する。
    if (record && !record.reserve_only) {
      await replyToUser(replyToken, '本日は出勤または勤怠申告の記録があります。リザーブ手当の追加が必要な場合は、管理者に連絡してください。');
      return;
    }

    if (record && record.reserve_only) {
      await replyToUser(replyToken, `${user.name}さん、本日のリザーブ手当（${RAIN_ALLOWANCE}円）はすでに申請済みです。`);
      return;
    }

    const today = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');
    const { error } = await supabase.from('attendance').insert([{
      line_uid: uid,
      date: today,
      reserve_only: true,
      rain_allowance: RAIN_ALLOWANCE,
      transportation: 0,
      break_minutes: 0,
      work_minutes: 0
    }]);

    if (error) {
      console.error('Reserve-only application error:', error);
      await replyToUser(replyToken, 'リザーブ申請の登録中にエラーが発生しました。管理者に連絡してください。');
      return;
    }

    await replyToUser(replyToken, `${user.name}さん、リザーブ手当（${RAIN_ALLOWANCE}円）を記録しました。\n出勤打刻・交通費・勤務時間は加算されません。`);
    return;
  }

  if (text === '名前登録' || text === '登録') {
    await setUserState(uid, 'REGISTER_NAME');
    await replyToUser(replyToken, '【スタッフ登録】\nお名前を入力してください。\n例）山田 太郎');
    return;
  }

  if (text === '打刻') {
    await replyToUser(replyToken, '📍 位置情報を送信して打刻してください。\n\n画面下の「+」ボタン → 「位置情報」をタップしてください。');
    return;
  }

  if (text === 'マニュアル' || text === '就業規則') {
    await replyToUser(replyToken, '📖 使い方マニュアルはこちらから確認できます。\n\nhttps://trbsystemdev-blip.github.io/trb-liff/manual.html\n\n打刻・日報・シフト提出の手順を確認できます。');
    return;
  }

  if (text === '日報' || text === '日報入力') {
    await startReportFlow(uid, replyToken);
    return;
  }

  // 退勤後申告（例：「退勤申告 18:30」）
  const clockOutMatch = text.match(/^退勤申告\s*(\d{1,2}:\d{2})/);
  if (clockOutMatch) {
    await handleClockOutRequest(uid, clockOutMatch[1], replyToken);
    return;
  }

  // 出勤後申告（例：「出勤申告 09:00」）
  const clockInMatch = text.match(/^出勤申告\s*(\d{1,2}:\d{2})/);
  if (clockInMatch) {
    await handleClockInRequest(uid, clockInMatch[1], replyToken);
    return;
  }

  await replyToUser(replyToken, 'メニューから操作してください。');
}

// --- スタッフ登録フロー ---
async function handleRegisterName(uid, text, replyToken) {
  const name = text.trim();
  if (!name) {
    await replyToUser(replyToken, 'お名前を入力してください。');
    return;
  }
  await supabase.from('users').update({ name: name }).eq('line_uid', uid);
  await setUserState(uid, 'REGISTER_ROLE');
  await replyToUser(replyToken, `お名前「${name}」を登録しました。\n\n役職を入力してください。\n1. メインドライバー\n2. サブドライバー\n\n「1」または「2」を送信してください。`);
}

async function handleRegisterWage(uid, text, replyToken) {
  // このステートは現在未使用だが、万が一入った場合はリセットする
  await setUserState(uid, '');
  await replyToUser(replyToken, 'メニューから操作してください。');
}

async function handleRegisterRole(uid, text, replyToken) {
  let role = '';
  if (text === '1' || text.includes('メイン')) {
    role = 'メインドライバー';
  } else if (text === '2' || text.includes('サブ')) {
    role = 'サブドライバー';
  } else {
    await replyToUser(replyToken, '「1」（メインドライバー）または「2」（サブドライバー）を送信してください。');
    return;
  }
  await supabase.from('users').update({ role: role }).eq('line_uid', uid);
  await setUserState(uid, '');
  const user = await getUserInfo(uid);
  await replyToUser(replyToken, `【登録完了】\nお名前：${user.name}\n役職：${role}\n\n登録が完了しました！メニューから打刻を開始してください。\n※時給は管理者が設定します。`);
}

// --- 出勤後申告フロー ---
async function handleClockInRequest(uid, timeStr, replyToken, reason = '') {
  await ensureUserExists(uid);
  const user = await getUserInfo(uid);
  const record = await findTodayAttendance(uid);

  if (record && record.reserve_only) {
    await replyToUser(replyToken, '本日はリザーブ手当のみの申請日として登録されています。出勤申告はできません。勤務することになった場合は、管理者に連絡してください。');
    return;
  }

  if (record && record.clock_in) {
    await replyToUser(replyToken, `本日の出勤時刻はすでに記録されています（${record.clock_in.substring(0,5)}）。`);
    return;
  }

  // 時刻バリデーション
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) {
    await replyToUser(replyToken, '時刻の形式が正しくありません。例）出勤申告 09:00');
    return;
  }

  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason || normalizedReason.length > 200) {
    await setUserState(uid, `CLOCK_IN_REASON:${timeStr}`);
    await replyToUser(replyToken, '出勤打刻を忘れた理由を入力してください（1〜200文字）。\n例）打刻操作を失念しました');
    return;
  }

  if (record) {
    // 既存レコード（出勤なし）に pending_clock_in を保存
    const { error } = await supabase
      .from('attendance')
      .update({ pending_clock_in: timeStr, pending_clock_in_reason: normalizedReason })
      .eq('id', record.id);
    if (error) {
      console.error('handleClockInRequest update error:', error);
      await replyToUser(replyToken, 'エラーが発生しました。管理者に連絡してください。');
      return;
    }
  } else {
    // 当日レコードがない場合は新規作成
    const today = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');
    const { error } = await supabase
      .from('attendance')
      .insert([{
        line_uid: uid,
        date: today,
          pending_clock_in: timeStr,
          pending_clock_in_reason: normalizedReason,
          break_minutes: BREAK_MINUTES,
        transportation: TRANSPORT_FEE
      }]);
    if (error) {
      console.error('handleClockInRequest insert error:', error);
      await replyToUser(replyToken, 'エラーが発生しました。管理者に連絡してください。');
      return;
    }
  }

  await setUserState(uid, '');
  await replyToUser(replyToken, `出勤後申告（${timeStr}）を受付けました。\n理由：${normalizedReason}\n管理者の承認待ちとなります。承認後に出勤時刻が確定されます。`);
}

// --- 退勤後申告フロー ---
async function handleClockOutRequest(uid, timeStr, replyToken, reason = '') {
  const user = await getUserInfo(uid);
  const record = await findTodayAttendance(uid);
  
  if (!record) {
    await replyToUser(replyToken, '本日の出勤記録がありません。先に出勤打刻をしてください。');
    return;
  }
  if (record.reserve_only) {
    await replyToUser(replyToken, '本日はリザーブ手当のみの申請日として登録されています。退勤申告はできません。勤務することになった場合は、管理者に連絡してください。');
    return;
  }
  if (record.clock_out) {
    await replyToUser(replyToken, `本日の退勤時刻はすでに記録されています（${record.clock_out.substring(0,5)}）。`);
    return;
  }

  // 時刻バリデーション
  const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) {
    await replyToUser(replyToken, '時刻の形式が正しくありません。例）退勤申告 18:30');
    return;
  }

  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason || normalizedReason.length > 200) {
    await setUserState(uid, `CLOCK_OUT_REASON:${timeStr}`);
    await replyToUser(replyToken, '退勤打刻を忘れた理由を入力してください（1〜200文字）。\n例）打刻操作を失念しました');
    return;
  }

  // 承認待ちレコードとして保存
  const { error } = await supabase
    .from('attendance')
    .update({
      pending_clock_out: timeStr,
      pending_clock_out_reason: normalizedReason,
      pending_reason: normalizedReason
    })
    .eq('id', record.id);

  if (error) {
    console.error('handleClockOutRequest error:', error);
    await replyToUser(replyToken, 'エラーが発生しました。管理者に連絡してください。');
    return;
  }

  await setUserState(uid, '');
  await replyToUser(replyToken, `退勤後申告（${timeStr}）を受付けました。\n理由：${normalizedReason}\n管理者の承認待ちとなります。承認後に退勤時刻が確定されます。`);
}

async function startReportFlow(uid, replyToken) {
  // replyTokenの有効期限切れを防ぐため、返信を先に送る
  await replyToUser(replyToken, '【日報入力】\n本日の主な業務内容を入力してください。\n\n例）ツアー運搬、レンタル運搬、両方、その他');
  await setUserState(uid, 'REPORT_1');
  tempCache[uid] = {};
}

async function handleReportFlow(uid, text, replyToken) {
  const user = await getUserInfo(uid);
  const state = user.state;
  const data = tempCache[uid] || {};

  if (state === 'REPORT_1') {
    data.taskType = text;
    tempCache[uid] = data;
    await replyToUser(replyToken, '運搬した自転車の台数を入力してください。\n例）10台');
    await setUserState(uid, 'REPORT_2');
  } else if (state === 'REPORT_2') {
    data.count = text;
    tempCache[uid] = data;
    await replyToUser(replyToken, '特記事項・申し送り事項があれば入力してください。\nなければ「なし」と送信してください。');
    await setUserState(uid, 'REPORT_3');
  } else if (state === 'REPORT_3') {
    data.note = text;
    await saveReport(uid, data, replyToken);
  }
}

async function saveReport(uid, data, replyToken) {
  const todayStr = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');

  // replyTokenの有効期限切れを防ぐため、返信を先に送る
  await replyToUser(replyToken, `【日報を保存しました】\n業務内容：${data.taskType}\n台数：${data.count}\n特記事項：${data.note}\n\nお疲れ様でした！`);

  const { error } = await supabase
    .from('reports')
    .insert([{
      line_uid: uid,
      date: todayStr,
      task_type: data.taskType || '',
      count: data.count || '',
      note: data.note || ''
    }]);
    
  if (error) console.error('saveReport error:', error);

  await setUserState(uid, '');
  delete tempCache[uid];
}

// --- LINE 送信ユーティリティ ---
async function pushToUser(uid, message) {
  try {
    await axios.post('https://api.line.me/v2/bot/message/push', {
      to: uid,
      messages: [{ type: 'text', text: message }]
    }, { headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } });
  } catch (err) {
    console.error('pushToUser error:', err.response ? err.response.data : err.message);
  }
}

async function replyToUser(replyToken, message) {
  const isPush = replyToken && replyToken.startsWith('U');
  const url = isPush ? 'https://api.line.me/v2/bot/message/push' : 'https://api.line.me/v2/bot/message/reply';
  const payload = isPush ? { to: replyToken, messages: [{ type: 'text', text: message }] } : { replyToken: replyToken, messages: [{ type: 'text', text: message }] };

  try {
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` } });
  } catch (err) {
    console.error('replyToUser error:', err.response ? err.response.data : err.message);
  }
}

// --- エンドポイント ---
app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    if (!events || events.length === 0) return res.status(200).send('OK');

    for (const event of events) {
      const uid = event.source.userId;
      const replyToken = event.replyToken;

      if (event.type === 'message') {
        if (event.message.type === 'text') {
          await handleTextMessage(uid, event.message.text.trim(), replyToken);
        } else if (event.message.type === 'location') {
          await handleLocation(uid, event.message.latitude, event.message.longitude, replyToken);
        } else if (event.message.type === 'image') {
          await handleExpenseReceiptImage(uid, event.message.id, replyToken);
        }
      } else if (event.type === 'follow') {
        await ensureUserExists(uid);
        await replyToUser(replyToken, 'TRB勤怠管理システムへようこそ！\nメニューから操作してください。\n\n出勤・退勤は「打刻」ボタンから位置情報を送信してください。');
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Error');
  }
});

// LIFF用エンドポイント
app.get('/api/liff', async (req, res) => {
  const { action, lineUid, ym } = req.query;
  if (!lineUid) return res.json({ success: false, error: 'lineUid is required' });

  if (action === 'getUserInfo') {
    const user = await getUserInfo(lineUid);
    if (!user) return res.json({ success: false, error: 'User not found' });
    return res.json({ success: true, user: user });
  }

  if (action === 'getAttendanceData') {
    if (!ym) return res.json({ success: false, error: 'ym is required' });
    const user = await getUserInfo(lineUid);
    if (!user) return res.json({ success: false, error: 'User not found' });

    const year = ym.substring(0, 4);
    const month = ym.substring(4, 6);
    const startDate = `${year}-${month}-01`;
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

    const { data: monthRes } = await supabase
      .from('attendance')
      .select('*')
      .eq('line_uid', lineUid)
      .gte('date', startDate)
      .lte('date', endDate)
      .order('date', { ascending: true });
    
    let records = [];
    let totalWorkMin = 0;
    let totalPay = 0;
    let workDays = 0;

    if (monthRes) {
      records = monthRes.map(r => {
        const reserveOnly = r.reserve_only === true;
        const wMin = r.work_minutes || 0;
        const penalty = r.penalty || 0;
        const rain = r.rain_allowance || 0;
        const transport = reserveOnly ? 0 : (r.transportation || 0);
        const basePay = Math.round((wMin / 60) * user.hourlyWage);
        const dayPay = basePay + penalty + rain + transport;

        totalWorkMin += wMin;
        totalPay += dayPay;
        if (r.clock_in) workDays++;

        return {
          date: r.date,
          clockIn: r.clock_in ? r.clock_in.substring(0, 5) : null,
          clockOut: r.clock_out ? r.clock_out.substring(0, 5) : null,
          workMin: wMin,
          workHours: reserveOnly ? 'リザーブのみ' : ((wMin !== null && wMin !== undefined && wMin > 0) ? `${Math.floor(wMin/60)}h${wMin%60}m` : '-'),
          reserveOnly: reserveOnly,
          penalty: penalty,
          rain: rain,
          transport: transport,
          dayPay: dayPay
        };
      });
    }

    const todayStr = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');
    const { data: todayRes } = await supabase
      .from('attendance')
      .select('*')
      .eq('line_uid', lineUid)
      .eq('date', todayStr)
      .single();
      
    let todayData = null;
    if (todayRes) {
      todayData = {
        clockIn: todayRes.clock_in ? todayRes.clock_in.substring(0, 5) : null,
        clockOut: todayRes.clock_out ? todayRes.clock_out.substring(0, 5) : null,
        workMin: todayRes.work_minutes || 0,
        reserveOnly: todayRes.reserve_only === true
      };
    }

    const { data: shiftRes } = await supabase
      .from('shifts')
      .select('*')
      .eq('line_uid', lineUid)
      .gte('shift_date', startDate)
      .lte('shift_date', endDate)
      .order('shift_date', { ascending: true });
      
    let shifts = [];
    if (shiftRes) {
      shifts = shiftRes.map(r => ({
        date: r.shift_date,
        type: r.shift_type,
        startTime: r.start_time ? String(r.start_time).substring(0, 5) : null,
        endTime: r.end_time ? String(r.end_time).substring(0, 5) : null
      }));
    }

    return res.json({
      success: true,
      userName: user.name,
      role: user.role,
      hourlyWage: user.hourlyWage,
      today: todayData,
      summary: {
        workDays: workDays,
        totalWorkHours: `${Math.floor(totalWorkMin/60)}時間${totalWorkMin%60}分`,
        totalPay: totalPay,
        breakMinutes: BREAK_MINUTES
      },
      records: records,
      shifts: shifts
    });
  }

  res.json({ success: false, error: 'Unknown action' });
});

app.post('/api/liff', async (req, res) => {
  const { action, lineUid, entries } = req.body;
  if (!lineUid) return res.json({ success: false, error: 'lineUid is required' });

  if (action === 'saveShifts') {
    const user = await getUserInfo(lineUid);
    if (!user) return res.json({ success: false, error: 'User not found' });

    let saved = 0;
    for (const e of entries) {
      const type = String(e.type || '').trim();
      const startTime = e.startTime || null;
      const endTime = e.endTime || null;
      if (!e.date || !['出勤希望', '休み希望'].includes(type)) {
        return res.json({ success: false, error: 'シフト希望の内容が正しくありません。' });
      }
      if (type === '出勤希望') {
        const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
        if (!timePattern.test(String(startTime)) || !timePattern.test(String(endTime)) || startTime >= endTime) {
          return res.json({ success: false, error: '出勤希望は開始時刻・終了時刻を正しく入力してください。' });
        }
      }
      const { data: existing } = await supabase
        .from('shifts')
        .select('id')
        .eq('line_uid', lineUid)
        .eq('shift_date', e.date)
        .single();
        
      if (existing) {
        await supabase
          .from('shifts')
          .update({
            shift_type: type,
            start_time: type === '出勤希望' ? startTime : null,
            end_time: type === '出勤希望' ? endTime : null
          })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('shifts')
          .insert([{
            line_uid: lineUid,
            shift_date: e.date,
            shift_type: type,
            start_time: type === '出勤希望' ? startTime : null,
            end_time: type === '出勤希望' ? endTime : null
          }]);
      }
      saved++;
    }
    return res.json({ success: true, saved: saved });
  }

  if (action === 'saveReport') {
    const { reportData } = req.body;
    if (!reportData) return res.json({ success: false, error: 'reportData is required' });

    const todayStr = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');
    await supabase.from('reports').insert([{
      line_uid: lineUid,
      date: todayStr,
      task_type: reportData.taskType || reportData.tourType || '',
      count: reportData.count || '',
      note: reportData.note || ''
    }]);

    // LINEに通知
    const user = await getUserInfo(lineUid);
    const name = user ? user.name : lineUid;
    const msg = `【日報受信】\n名前：${name}\n業務：${reportData.taskType || reportData.tourType || ''}\n数量：${reportData.count || '-'}\n備考：${reportData.note || 'なし'}`;
    await pushToUser(lineUid, msg);

    return res.json({ success: true });
  }

  res.json({ success: false, error: 'Unknown action' });
});

// --- 管理者向けAPIエンドポイント ---
// 簡易パスワード認証ミドルウェア
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'trb-admin-2024';
function adminAuth(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.adminPassword || (req.body && req.body.adminPassword);
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: '認証エラー' });
  }
  next();
}

// スタッフ一覧取得
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .order('name', { ascending: true });
  if (error) return res.json({ success: false, error: error.message });
  return res.json({ success: true, users: data });
});

// 時給更新
app.post('/api/admin/updateWage', adminAuth, async (req, res) => {
  const { lineUid, hourlyWage } = req.body;
  if (!lineUid || hourlyWage === undefined) return res.json({ success: false, error: 'パラメータ不足' });
  const { error } = await supabase
    .from('users')
    .update({ hourly_wage: parseInt(hourlyWage, 10) })
    .eq('line_uid', lineUid);
  if (error) return res.json({ success: false, error: error.message });
  return res.json({ success: true });
});

// 勤怠一覧取得（月指定）
app.get('/api/admin/attendance', adminAuth, async (req, res) => {
  const { ym } = req.query;
  const parsed = parseYm(ym);
  if (!parsed) return res.json({ success: false, error: 'ym is required (format: 2026-06 or 202606)' });
  const { year, month, startDate, endDate } = parsed;

  const { data: attData, error } = await supabase
    .from('attendance')
    .select('*')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });
  if (error) return res.json({ success: false, error: error.message });

  const { data: usersData } = await supabase.from('users').select('line_uid, name, role, hourly_wage');
  const userMap = {};
  if (usersData) usersData.forEach(u => { userMap[u.line_uid] = u; });

  const records = (attData || []).map(r => {
    const u = userMap[r.line_uid] || {};
    const reserveOnly = r.reserve_only === true;
    const wMin = r.work_minutes || 0;
    const hourlyWage = u.hourly_wage || 0;
    const basePay = Math.round((wMin / 60) * hourlyWage);
    const penalty = r.penalty || 0;
    const rain = r.rain_allowance || 0;
    const transport = reserveOnly ? 0 : (r.transportation || 0);
    const dayPay = basePay + penalty + rain + transport;
    return {
      id: r.id,
      date: r.date,
      lineUid: r.line_uid,
      name: u.name || r.line_uid,
      role: u.role || '',
      clockIn: r.clock_in ? r.clock_in.substring(0, 5) : '-',
      clockOut: r.clock_out ? r.clock_out.substring(0, 5) : '-',
      workMin: wMin,
      workHours: reserveOnly ? 'リザーブのみ' : (wMin ? `${Math.floor(wMin/60)}h${wMin%60}m` : '-'),
      reserveOnly: reserveOnly,
      hourlyWage: hourlyWage,
      basePay: basePay,
      penalty: penalty,
      rain: rain,
      transport: transport,
      dayPay: dayPay
    };
  });
  return res.json({ success: true, records });
});

// シフト一覧取得（月指定）
app.get('/api/admin/shifts', adminAuth, async (req, res) => {
  const { ym } = req.query;
  const parsed = parseYm(ym);
  if (!parsed) return res.json({ success: false, error: 'ym is required (format: 2026-06 or 202606)' });
  const { year, month, startDate, endDate } = parsed;

  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .gte('shift_date', startDate)
    .lte('shift_date', endDate)
    .order('shift_date', { ascending: true });
  if (error) return res.json({ success: false, error: error.message });

  const { data: usersData } = await supabase.from('users').select('line_uid, name');
  const userMap = {};
  if (usersData) usersData.forEach(u => { userMap[u.line_uid] = u.name || u.line_uid; });

  const records = (data || []).map(r => ({
    id: r.id,
    date: r.shift_date,
    lineUid: r.line_uid,
    name: userMap[r.line_uid] || r.line_uid,
    type: r.shift_type,
    startTime: r.start_time ? String(r.start_time).substring(0, 5) : null,
    endTime: r.end_time ? String(r.end_time).substring(0, 5) : null
  }));
  return res.json({ success: true, records });
});

// 日報一覧取得（月指定）
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  const { ym } = req.query;
  const parsed = parseYm(ym);
  if (!parsed) return res.json({ success: false, error: 'ym is required (format: 2026-06 or 202606)' });
  const { year, month, startDate, endDate } = parsed;

  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true });
  if (error) return res.json({ success: false, error: error.message });

  const { data: usersData } = await supabase.from('users').select('line_uid, name');
  const userMap = {};
  if (usersData) usersData.forEach(u => { userMap[u.line_uid] = u.name || u.line_uid; });

  const records = (data || []).map(r => ({
    id: r.id,
    date: r.date,
    lineUid: r.line_uid,
    name: userMap[r.line_uid] || r.line_uid,
    taskType: r.task_type,
    count: r.count,
    note: r.note,
    createdAt: r.created_at
  }));
  return res.json({ success: true, records });
});

// 月次集計（スタッフ別）
app.get('/api/admin/monthly-summary', adminAuth, async (req, res) => {
  const { ym } = req.query;
  const parsed = parseYm(ym);
  if (!parsed) return res.json({ success: false, error: 'ym is required (format: 2026-06 or 202606)' });
  const { year, month, startDate, endDate } = parsed;

  const { data: attData } = await supabase
    .from('attendance')
    .select('*')
    .gte('date', startDate)
    .lte('date', endDate);

  const { data: usersData } = await supabase.from('users').select('line_uid, name, role, hourly_wage');
  const userMap = {};
  if (usersData) usersData.forEach(u => { userMap[u.line_uid] = u; });

  const summary = {};
  (attData || []).forEach(r => {
    const uid = r.line_uid;
    if (!summary[uid]) {
      const u = userMap[uid] || {};
      summary[uid] = {
        lineUid: uid,
        name: u.name || uid,
        role: u.role || '',
        hourlyWage: u.hourly_wage || 0,
        workDays: 0,
        totalWorkMin: 0,
        totalBasePay: 0,
        totalPenalty: 0,
        totalRain: 0,
        totalTransport: 0,
        totalPay: 0
      };
    }
    const s = summary[uid];
    const wMin = r.work_minutes || 0;
    const basePay = Math.round((wMin / 60) * s.hourlyWage);
    const penalty = r.penalty || 0;
    const rain = r.rain_allowance || 0;
    const transport = r.reserve_only ? 0 : (r.transportation || 0);
    if (r.clock_in && !r.reserve_only) s.workDays++;
    s.totalWorkMin += wMin;
    s.totalBasePay += basePay;
    s.totalPenalty += penalty;
    s.totalRain += rain;
    s.totalTransport += transport;
    s.totalPay += basePay + penalty + rain + transport;
  });

  const result = Object.values(summary).map(s => ({
    ...s,
    totalWorkHours: `${Math.floor(s.totalWorkMin/60)}時間${s.totalWorkMin%60}分`
  }));

  return res.json({ success: true, summary: result });
});

// 経費管理：設定・台帳・残高
app.get('/api/admin/expense-settings', adminAuth, async (req, res) => {
  let settings = await getExpenseSettings();
  settings = await ensureExpenseAlertRecipient(settings);
  if (!settings) return res.json({ success: false, error: '経費設定を取得できませんでした。SQL移行を実行してください。' });
  const { data: users, error } = await supabase
    .from('users')
    .select('line_uid, name, role')
    .order('name', { ascending: true });
  if (error) return res.json({ success: false, error: error.message });
  return res.json({ success: true, settings, users: users || [] });
});

app.post('/api/admin/expense-settings', adminAuth, async (req, res) => {
  const { openingBalance, lowBalanceThreshold, alertLineUid } = req.body;
  const opening = Number(openingBalance);
  const threshold = Number(lowBalanceThreshold);
  if (!Number.isInteger(opening) || opening < 0 || !Number.isInteger(threshold) || threshold < 0) {
    return res.json({ success: false, error: '開始残高・アラート基準は0以上の整数で入力してください。' });
  }
  let resolvedAlertLineUid = alertLineUid || null;
  // フロントエンドが候補を取得できない場合でも、既定通知先の渡部大輔さんを安全に解決する。
  if (resolvedAlertLineUid === '__WATANABE_DAISUKE__') {
    const { data: defaultRecipient } = await supabase
      .from('users')
      .select('line_uid')
      .ilike('name', '%渡部大輔%')
      .limit(1);
    if (!defaultRecipient || !defaultRecipient[0]) {
      return res.json({ success: false, error: '渡部大輔さんのLINE登録情報が見つかりません。スタッフ管理で登録状況を確認してください。' });
    }
    resolvedAlertLineUid = defaultRecipient[0].line_uid;
  }
  if (!resolvedAlertLineUid) {
    return res.json({ success: false, error: '通知先を選択してください。' });
  }

  const { data, error } = await supabase
    .from('expense_settings')
    .upsert({
      id: 1,
      opening_balance: opening,
      low_balance_threshold: threshold,
      alert_line_uid: resolvedAlertLineUid,
      is_low_balance_alerted: false,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();
  if (error) return res.json({ success: false, error: error.message });
  const balanceResult = await updateLowBalanceAlert();
  return res.json({ success: true, settings: data, balance: balanceResult.balance });
});

app.get('/api/admin/expenses', adminAuth, async (req, res) => {
  const { ym } = req.query;
  const parsed = ym ? parseYm(ym) : null;
  if (ym && !parsed) return res.json({ success: false, error: 'ym must be 2026-06 or 202606' });

  let query = supabase
    .from('expenses')
    .select('*')
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });
  if (parsed) query = query.gte('transaction_date', parsed.startDate).lte('transaction_date', parsed.endDate);
  const { data: rows, error } = await query;
  if (error) return res.json({ success: false, error: error.message });

  const { data: usersData } = await supabase.from('users').select('line_uid, name');
  const userMap = {};
  (usersData || []).forEach(u => { userMap[u.line_uid] = u.name || u.line_uid; });
  const records = await Promise.all((rows || []).map(async row => {
    let receiptUrl = null;
    if (row.receipt_path) {
      const { data: signed } = await supabase.storage
        .from(EXPENSE_RECEIPT_BUCKET)
        .createSignedUrl(row.receipt_path, 60 * 60);
      receiptUrl = signed ? signed.signedUrl : null;
    }
    return {
      id: row.id,
      date: row.transaction_date,
      type: row.transaction_type,
      amount: Number(row.amount) || 0,
      purpose: row.purpose,
      note: row.note || '',
      reporter: row.reported_by ? (userMap[row.reported_by] || row.reported_by) : '管理者',
      receiptUrl,
      createdAt: row.created_at
    };
  }));

  const monthTotals = { expense: 0, replenishment: 0, loss: 0 };
  records.forEach(r => { monthTotals[r.type] += r.amount; });
  const balanceResult = await calculateExpenseBalance();
  if (balanceResult.balance === null) return res.json({ success: false, error: '残高を計算できませんでした。SQL移行を確認してください。' });
  return res.json({
    success: true,
    records,
    balance: balanceResult.balance,
    settings: balanceResult.settings,
    allTimeTotals: balanceResult.totals,
    monthTotals
  });
});

app.post('/api/admin/expense-transaction', adminAuth, async (req, res) => {
  const { transactionType, amount, purpose, note } = req.body;
  if (!['replenishment', 'loss', 'expense'].includes(transactionType)) {
    return res.json({ success: false, error: '取引種別が不正です。' });
  }
  const numericAmount = Number(amount);
  const normalizedPurpose = String(purpose || '').trim();
  if (!Number.isInteger(numericAmount) || numericAmount <= 0 || numericAmount > 1000000 || !normalizedPurpose || normalizedPurpose.length > 200) {
    return res.json({ success: false, error: '金額（1〜1,000,000円）と用途（1〜200文字）を入力してください。' });
  }
  const result = await addExpenseTransaction({
    transactionType,
    amount: numericAmount,
    purpose: normalizedPurpose,
    note: String(note || '').trim() || null
  });
  if (result.error) return res.json({ success: false, error: result.error.message });
  return res.json({ success: true, record: result.data, balance: result.balance });
});

// 承認待き申告一覧取得（出勤申告・退勤申告の両方）
app.get('/api/admin/pending', adminAuth, async (req, res) => {
  // 退勤申告待ち
  const { data: outData, error: outErr } = await supabase
    .from('attendance')
    .select('*')
    .not('pending_clock_out', 'is', null)
    .is('clock_out', null)
    .order('date', { ascending: false });
  if (outErr) return res.json({ success: false, error: outErr.message });

  // 出勤申告待ち
  const { data: inData, error: inErr } = await supabase
    .from('attendance')
    .select('*')
    .not('pending_clock_in', 'is', null)
    .is('clock_in', null)
    .order('date', { ascending: false });
  if (inErr) return res.json({ success: false, error: inErr.message });

  const { data: usersData } = await supabase.from('users').select('line_uid, name');
  const userMap = {};
  if (usersData) usersData.forEach(u => { userMap[u.line_uid] = u.name || u.line_uid; });

  const outRecords = (outData || []).map(r => ({
    id: r.id,
    date: r.date,
    lineUid: r.line_uid,
    name: userMap[r.line_uid] || r.line_uid,
    type: 'clockOut',
    clockIn: r.clock_in ? r.clock_in.substring(0, 5) : '-',
    clockOut: r.clock_out ? r.clock_out.substring(0, 5) : '-',
    pendingClockOut: r.pending_clock_out,
    pendingClockIn: null,
    pendingReason: r.pending_clock_out_reason || r.pending_reason || '理由未入力'
  }));

  const inRecords = (inData || []).map(r => ({
    id: r.id,
    date: r.date,
    lineUid: r.line_uid,
    name: userMap[r.line_uid] || r.line_uid,
    type: 'clockIn',
    clockIn: '-',
    clockOut: r.clock_out ? r.clock_out.substring(0, 5) : '-',
    pendingClockOut: null,
    pendingClockIn: r.pending_clock_in,
    pendingReason: r.pending_clock_in_reason || '理由未入力'
  }));

  // 日付降順でマージ
  const records = [...outRecords, ...inRecords].sort((a, b) => b.date.localeCompare(a.date));
  return res.json({ success: true, records });
});

// 出勤後申告を承認
app.post('/api/admin/approveClockIn', adminAuth, async (req, res) => {
  const { attendanceId } = req.body;
  if (!attendanceId) return res.json({ success: false, error: 'attendanceId is required' });

  const { data: rec, error: fetchErr } = await supabase
    .from('attendance')
    .select('*')
    .eq('id', attendanceId)
    .single();
  if (fetchErr || !rec) return res.json({ success: false, error: 'レコードが見つかりません' });

  const TZ = 'Asia/Tokyo';
  const pendingIn = rec.pending_clock_in;
  const inDate = new Date(`${rec.date}T${pendingIn.padStart(5,'0')}:00+09:00`);
  const roundedIn = roundTime(inDate, true);
  const clockInStr = format(toZonedTime(roundedIn, TZ), 'HH:mm');

  // work_minutesは退勤も揃っている場合のみ計算
  let workMin = 0;
  const outTime = rec.clock_out ? rec.clock_out.substring(0, 5) : null;
  if (outTime) {
    const outDate = new Date(`${rec.date}T${outTime}:00+09:00`);
    const totalMin = Math.round((outDate - roundedIn) / 60000);
    workMin = calcWorkMin(totalMin);
  }

  const updateData = {
    clock_in: clockInStr,
    clock_in_raw: pendingIn,
    pending_clock_in: null,
    pending_clock_in_reason: null
  };
  if (outTime) updateData.work_minutes = workMin;

  const { error } = await supabase
    .from('attendance')
    .update(updateData)
    .eq('id', attendanceId);
  if (error) return res.json({ success: false, error: error.message });

  // スタッフにLINE通知
  try {
    const { data: user } = await supabase.from('users').select('name').eq('line_uid', rec.line_uid).single();
    const name = user ? user.name : rec.line_uid;
    await pushToUser(rec.line_uid, `【出勤承認】${name}さん
出勤時刻：${pendingIn} → 見なし時刻：${clockInStr}（管理者承認済）`);
  } catch(e) {}

  return res.json({ success: true, clockIn: clockInStr });
});

// 出勤後申告を却下
app.post('/api/admin/rejectClockIn', adminAuth, async (req, res) => {
  const { attendanceId } = req.body;
  if (!attendanceId) return res.json({ success: false, error: 'attendanceId is required' });

  const { data: rec } = await supabase.from('attendance').select('line_uid, pending_clock_in').eq('id', attendanceId).single();

  const { error } = await supabase
    .from('attendance')
    .update({ pending_clock_in: null, pending_clock_in_reason: null })
    .eq('id', attendanceId);
  if (error) return res.json({ success: false, error: error.message });

  try {
    if (rec) await pushToUser(rec.line_uid, `【出勤申告却下】出勤後申告（${rec.pending_clock_in}）は却下されました。管理者にお問い合わせください。`);
  } catch(e) {}

  return res.json({ success: true });
});

// 退勤後申告を承認
app.post('/api/admin/approveClockOut', adminAuth, async (req, res) => {
  const { attendanceId } = req.body;
  if (!attendanceId) return res.json({ success: false, error: 'attendanceId is required' });

  const { data: rec, error: fetchErr } = await supabase
    .from('attendance')
    .select('*')
    .eq('id', attendanceId)
    .single();
  if (fetchErr || !rec) return res.json({ success: false, error: 'レコードが見つかりません' });

  const inTime = rec.clock_in ? rec.clock_in.substring(0, 5) : null;
  const outTime = rec.pending_clock_out;
  let workMin = 0;
  if (inTime && outTime) {
    const inDate = new Date(`${rec.date}T${inTime}:00+09:00`);
    const outDate = new Date(`${rec.date}T${outTime}:00+09:00`);
    const totalMin = Math.round((outDate - inDate) / 60000);
    workMin = calcWorkMin(totalMin);
  }

  const { error } = await supabase
    .from('attendance')
    .update({
      clock_out: outTime,
      work_minutes: workMin,
      pending_clock_out: null,
      pending_clock_out_reason: null,
      pending_reason: null
    })
    .eq('id', attendanceId);
  if (error) return res.json({ success: false, error: error.message });

  // スタッフにLINE通知
  try {
    const { data: user } = await supabase.from('users').select('name').eq('line_uid', rec.line_uid).single();
    const name = user ? user.name : rec.line_uid;
    const workH = Math.floor(workMin / 60);
    const workM = workMin % 60;
    await pushToUser(rec.line_uid, `【退勤承認】${name}さん
退勤時刻：${outTime}（管理者承認済）
実労働：${workH}時間${workM}分（休憩1時間自動控除）`);
  } catch(e) {}

  return res.json({ success: true, workMin });
});

// 退勤後申告を却下
app.post('/api/admin/rejectClockOut', adminAuth, async (req, res) => {
  const { attendanceId } = req.body;
  if (!attendanceId) return res.json({ success: false, error: 'attendanceId is required' });

  const { data: rec } = await supabase.from('attendance').select('line_uid, pending_clock_out').eq('id', attendanceId).single();

  const { error } = await supabase
    .from('attendance')
    .update({ pending_clock_out: null, pending_clock_out_reason: null, pending_reason: null })
    .eq('id', attendanceId);
  if (error) return res.json({ success: false, error: error.message });

  // スタッフにLINE通知
  try {
    if (rec) await pushToUser(rec.line_uid, `【退勤申告却下】退勤後申告（${rec.pending_clock_out}）は却下されました。管理者にお問い合わせください。`);
  } catch(e) {}

  return res.json({ success: true });
});

// 過去データの勤務時間を再計算（時給変更後に使用）
app.post('/api/admin/recalculate', adminAuth, async (req, res) => {
  const { ym } = req.body;
  const parsed = parseYm(ym);
  if (!parsed) return res.json({ success: false, error: 'ym is required (format: 2026-06 or 202606)' });
  const { year, month, startDate, endDate } = parsed;

  const { data: attData, error } = await supabase
    .from('attendance')
    .select('*')
    .gte('date', startDate)
    .lte('date', endDate);
  if (error) return res.json({ success: false, error: error.message });

  let updated = 0;
  for (const r of (attData || [])) {
    if (!r.clock_in || !r.clock_out) continue;
    const inTime = r.clock_in.substring(0, 5);
    const outTime = r.clock_out.substring(0, 5);
    const inDate = new Date(`${r.date}T${inTime}:00+09:00`);
    const outDate = new Date(`${r.date}T${outTime}:00+09:00`);
    if (isNaN(inDate) || isNaN(outDate)) continue;
    // 丸め処理を適用（出勤：切り上げ、退勤：切り捨て）
    const roundedIn = roundTime(inDate, true);
    const roundedOut = roundTime(outDate, false);
    const totalMin = Math.round((roundedOut - roundedIn) / 60000);
    const workMin = calcWorkMin(totalMin);
    await supabase.from('attendance').update({ work_minutes: workMin }).eq('id', r.id);
    updated++;
  }

  return res.json({ success: true, updated });
});

// 勤怠レコードの出退勤時刻を手修正（管理者操作）
app.post('/api/admin/updateAttendance', adminAuth, async (req, res) => {
  const { attendanceId, clockIn, clockOut } = req.body;
  if (!attendanceId) return res.json({ success: false, error: 'attendanceId is required' });

  // 現在のレコードを取得
  const { data: rec, error: fetchErr } = await supabase
    .from('attendance')
    .select('*')
    .eq('id', attendanceId)
    .single();
  if (fetchErr || !rec) return res.json({ success: false, error: 'record not found' });

  const updates = {};

  const TZ = 'Asia/Tokyo';

  // 出勤時刻の更新
  if (clockIn) {
    const timeMatch = clockIn.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) return res.json({ success: false, error: '出勤時刻の形式が正しくありません（例：09:00）' });
    const inDate = new Date(`${rec.date}T${clockIn.padStart(5,'0')}:00+09:00`);
    const roundedIn = roundTime(inDate, true);
    updates.clock_in = format(toZonedTime(roundedIn, TZ), 'HH:mm');
    updates.clock_in_raw = clockIn;
  }

  // 退勤時刻の更新
  if (clockOut) {
    const timeMatch = clockOut.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) return res.json({ success: false, error: '退勤時刻の形式が正しくありません（例：18:00）' });
    const outDate = new Date(`${rec.date}T${clockOut.padStart(5,'0')}:00+09:00`);
    const roundedOut = roundTime(outDate, false);
    updates.clock_out = format(toZonedTime(roundedOut, TZ), 'HH:mm');
    updates.clock_out_raw = clockOut;
  }

  // リザーブ単独レコードへ勤務時刻を入力した場合は、通常勤務へ戻す。
  // 実際に勤務した日は交通費を通常どおり計上する。
  if (rec.reserve_only && (clockIn || clockOut)) {
    updates.reserve_only = false;
    updates.transportation = TRANSPORT_FEE;
  }

  // work_minutesを再計算
  const inTimeStr = (updates.clock_in || rec.clock_in || '').substring(0, 5);
  const outTimeStr = (updates.clock_out || rec.clock_out || '').substring(0, 5);
  if (inTimeStr && outTimeStr) {
    const inDate = new Date(`${rec.date}T${inTimeStr}:00+09:00`);
    const outDate = new Date(`${rec.date}T${outTimeStr}:00+09:00`);
    if (!isNaN(inDate) && !isNaN(outDate)) {
      const totalMin = Math.round((outDate - inDate) / 60000);
      updates.work_minutes = calcWorkMin(totalMin);
    }
  }

  const { error } = await supabase.from('attendance').update(updates).eq('id', attendanceId);
  if (error) return res.json({ success: false, error: error.message });

  return res.json({ success: true, updates });
});

// スタッフのstateをリセット（管理者操作）
app.post('/api/admin/resetState', adminAuth, async (req, res) => {
  const { lineUid } = req.body;
  if (!lineUid) return res.json({ success: false, error: 'lineUid is required' });
  const { error } = await supabase.from('users').update({ state: '' }).eq('line_uid', lineUid);
  if (error) return res.json({ success: false, error: error.message });
  return res.json({ success: true });
});

module.exports = app;
