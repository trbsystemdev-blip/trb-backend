-- SNS動画施策：LIFF専用口座登録フォームの追加列
-- 既存のsns_video_enrollment_migration.sqlを実行済みの場合に、続けて実行します。

ALTER TABLE public.sns_video_bank_accounts
  ADD COLUMN IF NOT EXISTS submission_source text NOT NULL DEFAULT 'liff_form',
  ADD COLUMN IF NOT EXISTS form_version text,
  ADD COLUMN IF NOT EXISTS form_submitted_at timestamptz;

ALTER TABLE public.sns_video_bank_accounts
  DROP CONSTRAINT IF EXISTS sns_video_bank_accounts_submission_source_check;

ALTER TABLE public.sns_video_bank_accounts
  ADD CONSTRAINT sns_video_bank_accounts_submission_source_check
  CHECK (submission_source IN ('line_bot', 'liff_form'));

ALTER TABLE public.sns_video_bank_account_access_logs
  ADD COLUMN IF NOT EXISTS accessed_by text,
  ADD COLUMN IF NOT EXISTS access_outcome text;

-- 口座情報テーブルは匿名クライアントから直接読めない状態を維持します。
ALTER TABLE public.sns_video_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sns_video_bank_account_access_logs ENABLE ROW LEVEL SECURITY;
