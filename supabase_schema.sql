-- TRB勤怠管理システム Supabase (PostgreSQL) スキーマ定義

-- 1. ユーザー（スタッフ）テーブル
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_uid TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'メインドライバー',
  hourly_wage INTEGER DEFAULT 0,
  state TEXT DEFAULT '',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. 勤怠テーブル
CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_uid TEXT NOT NULL REFERENCES users(line_uid),
  date DATE NOT NULL,
  clock_in TIME,
  clock_out TIME,
  work_minutes INTEGER DEFAULT 0,
  break_minutes INTEGER DEFAULT 60,
  penalty INTEGER DEFAULT 0,
  rain_allowance INTEGER DEFAULT 0,
  transportation INTEGER DEFAULT 500,
  gps TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(line_uid, date)
);

-- 3. シフトテーブル
CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_uid TEXT NOT NULL REFERENCES users(line_uid),
  shift_date DATE NOT NULL,
  shift_type TEXT NOT NULL, -- '出勤希望' or '休み希望'
  status TEXT DEFAULT '未確定', -- '未確定' or '確定'
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(line_uid, shift_date)
);

-- 4. 日報テーブル
CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  line_uid TEXT NOT NULL REFERENCES users(line_uid),
  date DATE NOT NULL,
  task_type TEXT,
  count TEXT,
  note TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 更新日時自動更新トリガー関数
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- トリガー設定
CREATE TRIGGER update_users_modtime BEFORE UPDATE ON users FOR EACH ROW EXECUTE PROCEDURE update_modified_column();
CREATE TRIGGER update_attendance_modtime BEFORE UPDATE ON attendance FOR EACH ROW EXECUTE PROCEDURE update_modified_column();
CREATE TRIGGER update_shifts_modtime BEFORE UPDATE ON shifts FOR EACH ROW EXECUTE PROCEDURE update_modified_column();
