# Claude Code PII Filter Fork

Claude Code CLI に PII（個人情報）フィルタリング機能を追加したフォーク。Anthropic API に送信される全データから個人情報を検出・マスクし、レスポンス表示時に復元する。

## アーキテクチャ

```
ユーザー入力 / ツール結果 / システムプロンプト
  → 正規表現フィルタ (EMAIL, PHONE, API_KEY 等)
  → Ollama 4B フィルタ (人名, 組織名 等)
  → プレースホルダ置換 ([NAME_1], [EMAIL_2] 等)
  → Anthropic API
  → レスポンス受信 → プレースホルダ復元 → 表示
```

## セットアップ

```bash
# 1. 依存関係とビルド
npm --prefix pii-proxy install
npm --prefix pii-proxy run build

# 2. 設定ファイルを作成
node pii-proxy/dist/cli.js init

# 3. Claude Code 用の接続先を設定
node pii-proxy/dist/cli.js install --for=claude-code

# 4. プロキシを起動
node pii-proxy/dist/cli.js start
```

Ollama を使った人名・組織名検出も有効にする場合:

```bash
brew install ollama
brew services start ollama
ollama pull gemma3:4b
```

## 設定

`~/.claude/pii-filter.json`:

```json
{
  "enabled": true,
  "categories": ["EMAIL","PHONE","NAME","ORG","ADDRESS","API_KEY","CREDIT_CARD","MY_NUMBER","SCHOOL"],
  "ollamaModel": "gemma3:4b",
  "ollamaEndpoint": "http://localhost:11434",
  "ollamaEnabled": true,
  "customPatterns": []
}
```

無効化: `CLAUDE_PII_FILTER=0 node dist/cli.js`

実行中の制御:

```bash
node pii-proxy/dist/cli.js status
curl -X POST http://127.0.0.1:8787/control/passthrough
curl -X POST http://127.0.0.1:8787/control/filter
curl -X POST http://127.0.0.1:8787/control/disable/PHONE
```

## 制限事項

- Ollama 4B モデルの人名検出精度は完全ではない
- 新規コンテンツブロックごとに 1〜2 秒のレイテンシが追加される
- ソースファイル内の PII がマスクされることで、コード生成の精度に影響が出る場合がある

## ソース解析レポート

Claude Code v2.1.88 のデコンパイルソースに基づく分析レポート。

- [日本語](docs/ja/)
- [English](docs/en/)
