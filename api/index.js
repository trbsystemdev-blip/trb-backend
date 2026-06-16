const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { format, addMinutes, subMinutes, roundToNearestMinutes } = require('date-fns');
const { toZonedTime } = require('date-fns-tz');

const app = express();
app.use(cors());
app.use(express.json());

// --- 定数 ---
const BREAK_MINUTES = 60;
const ROUND_MINUTES = 30;
const LATE_PENALTY = -500;
const RAIN_ALLOWANCE = 3000;
const TRANSPORT_FEE = 500;

// --- 環境変数 ---
const KINTONE_DOMAIN = process.env.KINTONE_DOMAIN;
const KINTONE_TOKEN_USERS = process.env.KINTONE_TOKEN_USERS;
const KINTONE_TOKEN_ATTENDANCE = process.env.KINTONE_TOKEN_ATTENDANCE;
const KINTONE_TOKEN_SHIFTS = process.env.KINTONE_TOKEN_SHIFTS;
const KINTONE_TOKEN_REPORTS = process.env.KINTONE_TOKEN_REPORTS;
const APP_ID_USERS = process.env.APP_ID_USERS;
const APP_ID_ATTENDANCE = process.env.APP_ID_ATTENDANCE;
const APP_ID_SHIFTS = process.env.APP_ID_SHIFTS;
const APP_ID_REPORTS = process.env.APP_ID_REPORTS;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// --- KINTONE API ユーティリティ ---
function getTokenForApp(appId) {
  const id = String(appId);
  if (id === APP_ID_USERS) return KINTONE_TOKEN_USERS;
  if (id === APP_ID_ATTENDANCE) return KINTONE_TOKEN_ATTENDANCE;
  if (id === APP_ID_SHIFTS) return KINTONE_TOKEN_SHIFTS;
  if (id === APP_ID_REPORTS) return KINTONE_TOKEN_REPORTS;
  return KINTONE_TOKEN_USERS;
}

async function kintoneGet(appId, query) {
  const token = getTokenForApp(appId);
  const url = `https://${KINTONE_DOMAIN}/k/v1/records.json?app=${appId}&query=${encodeURIComponent(query)}`;
  try {
    const res = await axios.get(url, { headers: { 'X-Cybozu-API-Token': token } });
    return res.data;
  } catch (err) {
    console.error('kintoneGet error:', err.response ? err.response.data : err.message);
    return { records: [] };
  }
}

async function kintonePost(appId, record) {
  const token = getTokenForApp(appId);
  const url = `https://${KINTONE_DOMAIN}/k/v1/record.json`;
  try {
    const res = await axios.post(url, { app: appId, record: record }, { headers: { 'X-Cybozu-API-Token': token } });
    return res.data;
  } catch (err) {
    console.error('kintonePost error:', err.response ? err.response.data : err.message);
    return null;
  }
}

async function kintonePut(appId, id, record) {
  const token = getTokenForApp(appId);
  const url = `https://${KINTONE_DOMAIN}/k/v1/record.json`;
  try {
    const res = await axios.put(url, { app: appId, id: id, record: record }, { headers: { 'X-Cybozu-API-Token': token } });
    return res.data;
  } catch (err) {
    console.error('kintonePut error:', err.response ? err.response.data : err.message);
    return null;
  }
}

// --- ユーザー情報管理 ---
async function getUserInfo(uid) {
  const res = await kintoneGet(APP_ID_USERS, `line_uid = "${uid}" limit 1`);
  if (res.records && res.records.length > 0) {
    const r = res.records[0];
    return {
      id: r.$id.value,
      name: r.name.value || uid,
      role: r.role.value || 'メインドライバー',
      hourlyWage: parseInt(r.hourly_wage ? r.hourly_wage.value : 0) || 0,
      state: r.state ? r.state.value : ''
    };
  }
  return null;
}

async function ensureUserExists(uid) {
  const user = await getUserInfo(uid);
  if (!user) {
    await kintonePost(APP_ID_USERS, {
      line_uid: { value: uid },
      name: { value: '' },
      role: { value: 'メインドライバー' },
      hourly_wage: { value: 0 },
      state: { value: '' }
    });
  }
}

async function setUserState(uid, state) {
  await ensureUserExists(uid);
  const user = await getUserInfo(uid);
  if (user) {
    await kintonePut(APP_ID_USERS, user.id, { state: { value: state } });
  }
}

// --- 勤怠打刻ロジック ---
function roundTime(dateObj, isClockIn) {
  const minutes = dateObj.getMinutes();
  const rounded = new Date(dateObj);
  if (isClockIn) {
    const mod = minutes % ROUND_MINUTES;
    if (mod <= ROUND_MINUTES) {
      rounded.setMinutes(minutes - mod, 0, 0);
    }
  } else {
    const mod = minutes % ROUND_MINUTES;
    if (mod > 0) {
      rounded.setMinutes(minutes + (ROUND_MINUTES - mod), 0, 0);
    }
  }
  return rounded;
}

async function findTodayAttendance(uid) {
  const today = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');
  const res = await kintoneGet(APP_ID_ATTENDANCE, `line_uid = "${uid}" and date = "${today}" limit 1`);
  if (res.records && res.records.length > 0) return res.records[0];
  return null;
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

      await kintonePost(APP_ID_ATTENDANCE, {
        date: { value: todayStr },
        line_uid: { value: uid },
        name: { value: user.name },
        role: { value: user.role },
        clock_in: { value: timeStr },
        break_minutes: { value: BREAK_MINUTES },
        transportation: { value: TRANSPORT_FEE },
        gps: { value: gps }
      });

      let msg = `《出勤》${user.name}さん\n打刻時刻：${actualStr}`;
      if (actualStr !== timeStr) msg += `\n見なし時刻：${timeStr}（前後${ROUND_MINUTES}分見なし）`;
      msg += `\n交通費：${TRANSPORT_FEE}円 ✅`;
      await replyToUser(replyToken, msg);

    } else if (!record.clock_out.value) {
      // 退勤
      const roundedOut = roundTime(now, false);
      const timeStr = format(roundedOut, 'HH:mm');
      const actualStr = format(now, 'HH:mm');

      const inTime = record.clock_in.value;
      let workMin = 0;
      let pay = 0;

      if (inTime) {
        const inDate = new Date(`${todayStr}T${inTime}:00+09:00`);
        const outDate = new Date(`${todayStr}T${timeStr}:00+09:00`);
        const totalMin = Math.round((outDate - inDate) / 60000);
        workMin = Math.max(0, totalMin - BREAK_MINUTES);

        const hourlyWage = user.hourlyWage || 0;
        const basePay = Math.round((workMin / 60) * hourlyWage);
        const penalty = parseInt(record.penalty ? record.penalty.value : 0) || 0;
        const rainAllowance = parseInt(record.rain_allowance ? record.rain_allowance.value : 0) || 0;
        const transport = parseInt(record.transportation ? record.transportation.value : TRANSPORT_FEE) || TRANSPORT_FEE;
        pay = basePay + penalty + rainAllowance + transport;
      }

      await kintonePut(APP_ID_ATTENDANCE, record.$id.value, {
        clock_out: { value: timeStr },
        work_minutes: { value: workMin }
      });

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

// --- 日報フロー（簡易版、インメモリキャッシュ） ---
const tempCache = {};

async function handleTextMessage(uid, text, replyToken) {
  await ensureUserExists(uid);
  const user = await getUserInfo(uid);
  const state = user ? user.state : '';

  if (state && state.startsWith('REPORT_')) {
    await handleReportFlow(uid, text, replyToken);
    return;
  }

  if (text === '雨天補償申請') {
    const record = await findTodayAttendance(uid);
    if (record) {
      await kintonePut(APP_ID_ATTENDANCE, record.$id.value, { rain_allowance: { value: RAIN_ALLOWANCE } });
      await replyToUser(replyToken, `${user.name}さん、雨天補償（${RAIN_ALLOWANCE}円）を記録しました。`);
    } else {
      await replyToUser(replyToken, '本日の出勤記録がありません。先に出勤打刻をしてください。');
    }
    return;
  }

  if (text === '遅刻申告') {
    const record = await findTodayAttendance(uid);
    if (record) {
      await kintonePut(APP_ID_ATTENDANCE, record.$id.value, { penalty: { value: LATE_PENALTY } });
      await replyToUser(replyToken, `${user.name}さん、遅刻ペナルティ（${LATE_PENALTY}円）を記録しました。`);
    } else {
      await replyToUser(replyToken, '本日の出勤記録がありません。');
    }
    return;
  }

  if (text === '打刻') {
    await replyToUser(replyToken, '📍 位置情報を送信して打刻してください。\n\n画面下の「+」ボタン → 「位置情報」をタップしてください。');
    return;
  }

  if (text === 'マニュアル' || text === '就業規則') {
    await replyToUser(replyToken, '現在準備中です。しばらくお待ちください。');
    return;
  }

  if (text === '日報' || text === '日報入力') {
    await startReportFlow(uid, replyToken);
    return;
  }

  await replyToUser(replyToken, 'メニューから操作してください。');
}

async function startReportFlow(uid, replyToken) {
  await setUserState(uid, 'REPORT_1');
  tempCache[uid] = {};
  await replyToUser(replyToken, '【日報入力】\n本日の主な業務内容を入力してください。\n\n例）ツアー運搬、レンタル運搬、両方、その他');
}

async function handleReportFlow(uid, text, replyToken) {
  const user = await getUserInfo(uid);
  const state = user.state;
  const data = tempCache[uid] || {};

  if (state === 'REPORT_1') {
    data.taskType = text;
    tempCache[uid] = data;
    await setUserState(uid, 'REPORT_2');
    await replyToUser(replyToken, '運搬した自転車の台数を入力してください。\n例）10台');
  } else if (state === 'REPORT_2') {
    data.count = text;
    tempCache[uid] = data;
    await setUserState(uid, 'REPORT_3');
    await replyToUser(replyToken, '特記事項・申し送り事項があれば入力してください。\nなければ「なし」と送信してください。');
  } else if (state === 'REPORT_3') {
    data.note = text;
    await saveReport(uid, data, replyToken);
  }
}

async function saveReport(uid, data, replyToken) {
  const user = await getUserInfo(uid);
  const todayStr = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');

  await kintonePost(APP_ID_REPORTS, {
    date: { value: todayStr },
    line_uid: { value: uid },
    name: { value: user ? user.name : '' },
    role: { value: user ? user.role : '' },
    task_type: { value: data.taskType || '' },
    count: { value: data.count || '' },
    note: { value: data.note || '' }
  });

  await setUserState(uid, '');
  delete tempCache[uid];
  await replyToUser(replyToken, `【日報を保存しました】\n業務内容：${data.taskType}\n台数：${data.count}\n特記事項：${data.note}\n\nお疲れ様でした！`);
}

// --- LINE 送信ユーティリティ ---
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
    const endDate = `${year}-${month}-31`;

    const monthRes = await kintoneGet(APP_ID_ATTENDANCE, `line_uid = "${lineUid}" and date >= "${startDate}" and date <= "${endDate}" order by date asc limit 100`);
    
    let records = [];
    let totalWorkMin = 0;
    let totalPay = 0;
    let workDays = 0;

    if (monthRes.records) {
      records = monthRes.records.map(r => {
        const wMin = parseInt(r.work_minutes ? r.work_minutes.value : 0) || 0;
        const penalty = parseInt(r.penalty ? r.penalty.value : 0) || 0;
        const rain = parseInt(r.rain_allowance ? r.rain_allowance.value : 0) || 0;
        const transport = parseInt(r.transportation ? r.transportation.value : 0) || 0;
        const basePay = Math.round((wMin / 60) * user.hourlyWage);
        const dayPay = basePay + penalty + rain + transport;

        totalWorkMin += wMin;
        totalPay += dayPay;
        if (r.clock_in && r.clock_in.value) workDays++;

        return {
          date: r.date.value,
          clockIn: r.clock_in ? r.clock_in.value : null,
          clockOut: r.clock_out ? r.clock_out.value : null,
          workMin: wMin,
          workHours: wMin ? `${Math.floor(wMin/60)}h${wMin%60}m` : '-',
          penalty: penalty,
          rain: rain,
          transport: transport,
          dayPay: dayPay
        };
      });
    }

    const todayStr = format(toZonedTime(new Date(), 'Asia/Tokyo'), 'yyyy-MM-dd');
    const todayRes = await kintoneGet(APP_ID_ATTENDANCE, `line_uid = "${lineUid}" and date = "${todayStr}" limit 1`);
    let todayData = null;
    if (todayRes.records && todayRes.records.length > 0) {
      const r = todayRes.records[0];
      todayData = {
        clockIn: r.clock_in ? r.clock_in.value : null,
        clockOut: r.clock_out ? r.clock_out.value : null,
        workMin: parseInt(r.work_minutes ? r.work_minutes.value : 0) || 0
      };
    }

    const shiftRes = await kintoneGet(APP_ID_SHIFTS, `line_uid = "${lineUid}" and shift_date >= "${startDate}" and shift_date <= "${endDate}" order by shift_date asc limit 100`);
    let shifts = [];
    if (shiftRes.records) {
      shifts = shiftRes.records.map(r => ({
        date: r.shift_date.value,
        type: r.shift_time.value
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
      const existing = await kintoneGet(APP_ID_SHIFTS, `line_uid = "${lineUid}" and shift_date = "${e.date}" limit 1`);
      if (existing.records && existing.records.length > 0) {
        await kintonePut(APP_ID_SHIFTS, existing.records[0].$id.value, { shift_time: { value: e.type } });
      } else {
        await kintonePost(APP_ID_SHIFTS, {
          line_uid: { value: lineUid },
          name: { value: user.name },
          shift_date: { value: e.date },
          shift_time: { value: e.type }
        });
      }
      saved++;
    }
    return res.json({ success: true, saved: saved });
  }

  res.json({ success: false, error: 'Unknown action' });
});

module.exports = app;
