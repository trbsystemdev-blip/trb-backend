# TRB勤怠管理システム - Vercel版バックエンド (Supabase版)

TRBドライバー向け勤怠管理システムのバックエンドAPI。  
LINE Bot + Supabase (PostgreSQL) + LIFF（GitHub Pages）構成のVercel（Node.js/Express）版。

## 機能

- LINE Webhookハンドラ（打刻・日報・シフト・テキスト処理）
- Supabase連携（スタッフ取得・勤怠保存・シフト保存・日報保存）
- 給与計算ロジック（前後30分見なし・休憩1時間・交通費・遅刻ペナルティ・雨天補償）
- LIFF用APIエンドポイント（勤怠確認・シフト希望保存）

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| POST | /webhook | LINE Webhook受信 |
| GET | /api/liff | LIFF用データ取得 |
| POST | /api/liff | LIFF用データ保存（シフト希望） |

## 環境変数（Vercelに設定）

`.env.example` を参照してください。

## デプロイと初期設定

1. **Supabaseのセットアップ**
   - Supabaseで新しいプロジェクトを作成
   - `supabase_schema.sql` の内容をSQL Editorで実行してテーブルを作成
   - Project Settings > API から URL と `service_role` secret を取得

2. **Vercelへのデプロイ**
   - GitHubリポジトリを作成してこのコードをプッシュ
   - Vercelでリポジトリをインポート
   - 環境変数（`SUPABASE_URL`, `SUPABASE_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`）を設定してデプロイ

3. **LINEの設定**
   - LINE DeveloperコンソールのWebhook URLを `https://[VercelのURL]/webhook` に更新

## 給与計算ロジック

- 前後30分見なし：出勤は30分切り捨て、退勤は30分切り上げ
- 休憩：1時間（60分）自動控除
- 交通費：日額500円
- 遅刻ペナルティ：-500円
- 雨天補償：+3,000円
- 時給：Supabaseの `users` テーブルで設定
