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
  allowedHeaders: ['Content-Type', 'Authorization']
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
const ROUND_MINUTES = 30;
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
      state: data.state || ''
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

async function setUserState(uid, state) {
  await ensureUserExists(uid);
  const { error } = await supabase
    .from('users')
    .update({ state: state })
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

    } else if (!record.clock_out) {
      // 退勤
      const roundedOut = roundTime(now, false);
      const timeStr = format(roundedOut, 'HH:mm');
      const actualStr = format(now, 'HH:mm');

      // time型（HH:mm:ss）の場合も対応するため先頭5文字（HH:mm）のみ使用
      const inTime = record.clock_in ? record.clock_in.substring(0, 5) : null;
      let workMin = 0;
      let pay = 0;

      if (inTime) {
        const inDate = new Date(`${todayStr}T${inTime}:00+09:00`);
        const outDate = new Date(`${todayStr}T${timeStr}:00+09:00`);
        const totalMin = Math.round((outDate - inDate) / 60000);
        workMin = Math.max(0, totalMin - BREAK_MINUTES);

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
      let msg = `《退勤》${user.name}さん\n打刻時刻：${actualStr}`;
      if (actualStr !== timeStr) msg += `\n見なし時刻：${timeStr}（前後${ROUND_MINUTES}分見なし）`;
      msg += `\n実労働：${workH}時間${workM}分（休憩1時間自動控除）`;
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

  if (text === '雨天補償申請') {
    const record = await findTodayAttendance(uid);
    if (record) {
      await supabase.from('attendance').update({ rain_allowance: RAIN_ALLOWANCE }).eq('id', record.id);
      await replyToUser(replyToken, `${user.name}さん、雨天補償（${RAIN_ALLOWANCE}円）を記録しました。`);
    } else {
      await replyToUser(replyToken, '本日の出勤記録がありません。先に出勤打刻をしてください。');
    }
    return;
  }

  if (text === '遅刻申告') {
    const record = await findTodayAttendance(uid);
    if (record) {
      await supabase.from('attendance').update({ penalty: LATE_PENALTY }).eq('id', record.id);
      await replyToUser(replyToken, `${user.name}さん、遅刻ペナルティ（${LATE_PENALTY}円）を記録しました。`);
    } else {
      await replyToUser(replyToken, '本日の出勤記録がありません。');
    }
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

// --- 退勤後申告フロー ---
async function handleClockOutRequest(uid, timeStr, replyToken) {
  const user = await getUserInfo(uid);
  const record = await findTodayAttendance(uid);
  
  if (!record) {
    await replyToUser(replyToken, '本日の出勤記録がありません。先に出勤打刻をしてください。');
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

  // 承認待ちレコードとして保存
  const { error } = await supabase
    .from('attendance')
    .update({
      pending_clock_out: timeStr,
      pending_reason: '後申告'
    })
    .eq('id', record.id);

  if (error) {
    console.error('handleClockOutRequest error:', error);
    await replyToUser(replyToken, 'エラーが発生しました。管理者に連絡してください。');
    return;
  }

  await replyToUser(replyToken, `退勤後申告（${timeStr}）を受付けました。
管理者の承認待ちとなります。承認後に退勤時刻が確定されます。`);
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
        const wMin = r.work_minutes || 0;
        const penalty = r.penalty || 0;
        const rain = r.rain_allowance || 0;
        const transport = r.transportation || 0;
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
          workHours: (wMin !== null && wMin !== undefined && wMin > 0) ? `${Math.floor(wMin/60)}h${wMin%60}m` : '-',
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
        workMin: todayRes.work_minutes || 0
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
        type: r.shift_type
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
      const { data: existing } = await supabase
        .from('shifts')
        .select('id')
        .eq('line_uid', lineUid)
        .eq('shift_date', e.date)
        .single();
        
      if (existing) {
        await supabase
          .from('shifts')
          .update({ shift_type: e.type })
          .eq('id', existing.id);
      } else {
        await supabase
          .from('shifts')
          .insert([{
            line_uid: lineUid,
            shift_date: e.date,
            shift_type: e.type
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
  if (!ym) return res.json({ success: false, error: 'ym is required' });
  const year = ym.substring(0, 4);
  const month = ym.substring(4, 6);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

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
    const wMin = r.work_minutes || 0;
    const hourlyWage = u.hourly_wage || 0;
    const basePay = Math.round((wMin / 60) * hourlyWage);
    const penalty = r.penalty || 0;
    const rain = r.rain_allowance || 0;
    const transport = r.transportation || 0;
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
      workHours: wMin ? `${Math.floor(wMin/60)}h${wMin%60}m` : '-',
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
  if (!ym) return res.json({ success: false, error: 'ym is required' });
  const year = ym.substring(0, 4);
  const month = ym.substring(4, 6);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

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
    type: r.shift_type
  }));
  return res.json({ success: true, records });
});

// 日報一覧取得（月指定）
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  const { ym } = req.query;
  if (!ym) return res.json({ success: false, error: 'ym is required' });
  const year = ym.substring(0, 4);
  const month = ym.substring(4, 6);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

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
  if (!ym) return res.json({ success: false, error: 'ym is required' });
  const year = ym.substring(0, 4);
  const month = ym.substring(4, 6);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

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
    const transport = r.transportation || 0;
    if (r.clock_in) s.workDays++;
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

// 承認待ち退勤申告一覧取得
app.get('/api/admin/pending', adminAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .not('pending_clock_out', 'is', null)
    .is('clock_out', null)
    .order('date', { ascending: false });
  if (error) return res.json({ success: false, error: error.message });

  const { data: usersData } = await supabase.from('users').select('line_uid, name');
  const userMap = {};
  if (usersData) usersData.forEach(u => { userMap[u.line_uid] = u.name || u.line_uid; });

  const records = (data || []).map(r => ({
    id: r.id,
    date: r.date,
    lineUid: r.line_uid,
    name: userMap[r.line_uid] || r.line_uid,
    clockIn: r.clock_in ? r.clock_in.substring(0, 5) : '-',
    pendingClockOut: r.pending_clock_out,
    pendingReason: r.pending_reason || '後申告'
  }));
  return res.json({ success: true, records });
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
    workMin = Math.max(0, totalMin - BREAK_MINUTES);
  }

  const { error } = await supabase
    .from('attendance')
    .update({
      clock_out: outTime,
      work_minutes: workMin,
      pending_clock_out: null,
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
    .update({ pending_clock_out: null, pending_reason: null })
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
  if (!ym) return res.json({ success: false, error: 'ym is required' });
  const year = ym.substring(0, 4);
  const month = ym.substring(4, 6);
  const startDate = `${year}-${month}-01`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, '0')}`;

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
    const workMin = Math.max(0, totalMin - BREAK_MINUTES);
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

  // 出勤時刻の更新
  if (clockIn) {
    const timeMatch = clockIn.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) return res.json({ success: false, error: '出勤時刻の形式が正しくありません（例：09:00）' });
    const inDate = new Date(`${rec.date}T${clockIn.padStart(5,'0')}:00+09:00`);
    const roundedIn = roundTime(inDate, true);
    updates.clock_in = format(roundedIn, 'HH:mm');
    updates.clock_in_raw = clockIn;
  }

  // 退勤時刻の更新
  if (clockOut) {
    const timeMatch = clockOut.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) return res.json({ success: false, error: '退勤時刻の形式が正しくありません（例：18:00）' });
    const outDate = new Date(`${rec.date}T${clockOut.padStart(5,'0')}:00+09:00`);
    const roundedOut = roundTime(outDate, false);
    updates.clock_out = format(roundedOut, 'HH:mm');
    updates.clock_out_raw = clockOut;
  }

  // work_minutesを再計算
  const inTimeStr = (updates.clock_in || rec.clock_in || '').substring(0, 5);
  const outTimeStr = (updates.clock_out || rec.clock_out || '').substring(0, 5);
  if (inTimeStr && outTimeStr) {
    const inDate = new Date(`${rec.date}T${inTimeStr}:00+09:00`);
    const outDate = new Date(`${rec.date}T${outTimeStr}:00+09:00`);
    if (!isNaN(inDate) && !isNaN(outDate)) {
      const totalMin = Math.round((outDate - inDate) / 60000);
      updates.work_minutes = Math.max(0, totalMin - BREAK_MINUTES);
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
