# Responses API

Responses API (`POST /v1/responses`) 専用処理の配置先です。
現行バージョンには、この形式のリクエストのマスク・SSEの復元処理はありません。

今回の構成変更でも既存動作を維持し、このパスはフィルタ対象に登録していません。
従来どおり透過転送され、OpenAIへ転送するには `x-provider: openai` が必要です。
`input` / `instructions` のマスク、Responses固有のストリームイベントの復元、
回帰テストが揃った段階で、このフォルダにアダプターを実装し `api/index.ts` に登録します。

Chat Completions (`POST /v1/chat/completions`) は `../completions/`、
Anthropic Messages は `../messages/` が担当します。
