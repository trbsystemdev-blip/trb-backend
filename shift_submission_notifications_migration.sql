-- シフト希望の即時通知を、同じ提出操作ごとに一度だけ送るための記録テーブル
CREATE TABLE IF NOT EXISTS public.shift_submission_notifications (
  submission_key text PRIMARY KEY,
  line_uid text NOT NULL,
  target_months text NOT NULL,
  entry_count integer NOT NULL CHECK (entry_count > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shift_submission_notifications_created_at_idx
  ON public.shift_submission_notifications (created_at DESC);
