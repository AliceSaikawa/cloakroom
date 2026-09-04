# Cloakroom 仕様レビュー (2026-09)

- **レビュー対象**: README.md(仕様書相当)
- **レビュー実施**: Fable 5.1
- **観点**: 現在の Claude Code / Anthropic API / OpenAI API の実挙動(tool_use 中心・全履歴再送・プロンプトキャッシュ前提・ロングラン)との整合性
- **コード確認基準コミット**: `a73ebed`

各項目の「現状」欄は、レビュー内容を本リポジトリの実装に突き合わせて確認した結果。レビュー本文そのものは変更していない。

## 総評

「入口で預かり、番号札を渡し、出口で返す」という基本設計は正しい。制限事項・セキュリティ注意(`allowRemoteOllama`、プラグイン)を隠さない姿勢も良い。

一方、エージェント型コーディングへの追従が不足しており、そのままだと実運用で壊れる箇所がある(特に A-1、A-4)。

## 優先順位サマリ

| 優先 | 項目 |
|---|---|
| 今すぐ(動かないレベル) | A-1 `input_json_delta` / `tool_calls` の復元、A-4 上流 URL の設定化、A-5 `/control/*` の保護 |
| 次のマイナー | A-2 ステートレス化(+Ollama 結果のハッシュキャッシュ)、A-3 thinking 不変・検出の決定性要件、B `settings.json` 対応、C 既定値見直し(IP / カード / 郵便番号) |
| 中期 | D プレースホルダ形式の見直し、Responses API 対応、`HOME_PATH` カテゴリ、GLiNER プラグイン、embeddings / batches の遮断 |

A-1 と A-4 は「仕様の不足」ではなく「動かない」レベル。すでに実装済みなら README への明記だけでよい。

### 実装状況の突き合わせ

| 項目 | 現状(`a73ebed` 時点) |
|---|---|
| A-1 tool_use 入力の復元 | **未対応**。`src/streamRestorer.ts` は `delta.type === 'text_delta'` のみ、`src/openaiStreamRestorer.ts` は `choices[].delta.content` のみを復元する。`input_json_delta` / `partial_json` / `tool_calls` を扱うコードはリポジトリ内に存在しない |
| A-2 ステートレス化 | **部分対応**。FF3-1 FPE(`src/fpe.ts` / `src/fpeCodec.ts`)でステートレス可逆マスクの経路が入っているが、既定経路は依然 `src/sessionFilterStore.ts` のセッション単位 MappingTable。README にも FPE の記述がない |
| A-3 thinking 不変性 | **対応済み**。`src/piiFilter.ts:432`(リクエスト側でマスクしない)、`src/piiFilter.ts:520`(レスポンス側で復元しない)。README への明記は未了 |
| A-4 上流 URL の設定化 | **未対応**。`src/provider.ts` に `api.anthropic.com` / `api.openai.com` がハードコード。設定項目なし |
| A-5 `/control/*` の保護 | **未対応**。`src/server.ts:95` の `handleControlRequest` は `Host` 検証もトークン検証も行っていない |
| B `settings.json` 対応 | **未対応**。`settings.json` を参照するコードなし(`install` は `.env` 方式のまま) |
| B Responses API | **未対応**。`/v1/responses` の経路なし |
| B embeddings / batches 遮断 | **未対応**。該当パスの扱いはコード上に存在せず、透過される |
| B GLiNER 系プラグイン | **部分対応**。`examples/ginza-plugin` / `examples/onnx-plugin` と `src/pluginLoader.ts` あり |
| C・D・E・F | 未対応(仕様・既定値レベルの課題) |

---

## A. 致命的: 仕様変更を強く推奨

### A-1. `tool_use` 入力(`input_json_delta`)の復元が仕様にない

**現状**: 復元対象は「text_delta / choices[].delta」のみ。

**問題**:

- Claude Code の出力の大半はツール呼び出し(`Write` / `Edit` / `Bash`)。引数はストリームでは
  - Anthropic: `content_block_delta.delta.type == "input_json_delta"`(`partial_json`)
  - OpenAI: `choices[].delta.tool_calls[].function.arguments`
  - Responses API: `response.function_call_arguments.delta`
- ここを復元しないと `[メールアドレスA]` がそのままファイルに書き込まれ、`Edit` の `old_string` はファイルと一致せず失敗する。実質 Claude Code が使えない。
- `partial_json` は JSON 文字列エスケープ済みの断片。`fine-grained-tool-streaming` ベータでは不正な JSON 断片が届くため「パースしてから置換」は成立しない。**生文字列レベルで、エスケープ(`\u30e1...` 形式含む)を考慮した置換**が必要。

**推奨**:

- 仕様に「復元対象: text, input_json(partial_json), tool_calls.function.arguments, function_call_arguments」を明記
- テストに `Edit` ツールの往復ケース(プレースホルダを含む `old_string` / `new_string`)を追加

### A-2. セッション状態モデルの再設計(ステートレス化)

**現状**: ヘッダがあれば 30 分 TTL、無ければ TCP 接続が生きている間のみ。

**問題**:

- Claude Code は `x-pii-session-id` を送らず、接続は普通に切れる。数時間の作業や `claude -r` での再開で、過去のアシスタント発話に含まれるプレースホルダが復元不能になる。

**観察**:

- Claude Code は毎ターン全履歴をリクエストに含めて送る。
- 毎リクエスト、本文を文書順に走査して A, B, C… を割り当て直せば、**そのリクエストの復元に必要なマッピングはそのリクエスト自身から完全に再構築できる**。
- モデルが返せるプレースホルダは今回のリクエストに含まれるものだけなので、サーバ側にセッション状態を持つ必要が原理的にない。

**推奨**:

- ステートレス化により TTL・ソケット寿命・再起動・`x-pii-session-reset` の問題を一掃
- 成立条件は**検出の決定性**。辞書・正規表現・ヒューリスティックは決定的だが Ollama は非決定的なので、Ollama の結果は**コンテンツブロックのハッシュをキーにキャッシュ**し、可能ならディスクへ永続化(A-3 と直結)
- 補助案: Claude Code の `metadata.user_id`(`..._session_<uuid>` 形式、要確認)を明示ヘッダがない場合のフォールバックキーに使う

### A-3. プロンプトキャッシュとの相互作用が未考慮

**問題**:

- Claude Code は system・tools・履歴に `cache_control` を付けてプロンプトキャッシュに強く依存。キャッシュはバイト単位の前方一致。
- 以下のいずれかで前方一致が崩れると、毎ターン全履歴のキャッシュミス → 入力コストが最大 10 倍:
  - Ollama の揺らぎで前ターンと違う箇所がマスクされる
  - TTL 切れの振り直しで割り当てが変わる
  - 圧縮など別要因で本文が変わる

**推奨**:

- 「マスク処理は前方一致を壊さないこと(検出の決定性・過去ブロックの不変性)」を要件に格上げ
- **`thinking` / `redacted_thinking` ブロックはリクエスト側で一切触らない(再マスクもしない)**ことを明記。署名検証があるため、NER がモデルの出力した架空の名前を拾って書き換えるだけで壊れる。現状の記述は復元側の話に読め、リクエスト側の不変性が読み取れない

### A-4. 上流 URL が固定

**問題**:

- Anthropic 上流が `api.anthropic.com` 固定 → Bedrock / Vertex / Foundry / 社内ゲートウェイ(LiteLLM 等)経由の Claude Code で使えない
- OpenAI 互換上流が `api.openai.com` 固定 → OpenRouter / ローカル vLLM / Ollama の OpenAI 互換口 / Anthropic 自身の OpenAI 互換エンドポイント(`api.anthropic.com/v1/chat/completions`)が全滅

**推奨**:

- `upstreams: { anthropic: url, openai: url }` を設定項目として追加(実質必須)
- OSS 公開直後に最初に来る Issue になる可能性が高い

### A-5. `/control/*` が無認証(ブラウザからも叩ける)

**問題**:

- 同一ホストの任意プロセスに加え、Web ページ上の JavaScript が
  `fetch("http://127.0.0.1:8787/control/passthrough", {method:"POST"})`
  を投げると CORS の「単純リクエスト」として送信される(レスポンスは読めないが副作用は起きる)。
- ブラウザの Private Network Access で弾かれる場合もあるが、依存すべきではない。
- 悪意あるページを開いただけで静かにフィルタが切れる。

**推奨**(最低限):

1. `Host` ヘッダが `127.0.0.1:8787` / `localhost:8787` 以外なら拒否
2. `/control/*` にカスタムヘッダ(例 `X-Cloakroom-Control: 1`、プリフライトを強制できる)またはトークンを要求

---

## B. 現在の Claude Code / API 事情への追従

| 項目 | 現状 | 推奨 |
|---|---|---|
| Claude Code への接続設定 | `~/.claude/.env` に書く | Claude Code が公式に読むのは `~/.claude/settings.json` の `env` キー。`.env` の自動読込は保証されない。`install` は `settings.json.env` に `ANTHROPIC_BASE_URL` を書く(既存 JSON をマージ)方式に変更。`uninstall` サブコマンドも追加 |
| OAuth(Pro/Max)ログイン | 記載なし | `ANTHROPIC_BASE_URL` 経由で `Authorization: Bearer` と `anthropic-beta` 系ヘッダが透過されることを要件化・検証済みと明記 |
| OpenAI 側 API | Chat Completions のみ | 主 API は Responses API(`/v1/responses`)へ移行済み(Codex CLI 等)。`input` 配列と `response.output_text.delta` / `response.function_call_arguments.delta` への対応を追加 |
| `/v1/embeddings`, `/v1/messages/batches`, Files API | 透過 | 未マスクの本文がそのまま上流へ行く経路。既定で 403、少なくとも制限事項に太字で明記 |
| 画像・PDF(`image` / `document` ブロック) | docs 参照 | スクショ貼り付けは日常的に PII を含む。マスクできないなら `blockNonText: true`(拒否)オプションを用意し、`source.data`(base64)は正規表現走査をスキップする旨(性能)を明記 |
| system プロンプト | 辞書・正規表現のみ | Claude Code の system には cwd(`/Users/<ユーザー名>/…`)、git の user.name / email、ブランチ名が入る。ホームディレクトリのユーザー名は現状どのカテゴリにも該当しない。`HOME_PATH`(または `USERNAME`)カテゴリを追加。system は必ずキャッシュ対象なので置換は決定的であること |
| 1M コンテキスト | 記載なし | 毎ターン数 MB の本文に全段を走らせると重い。コンテンツブロック単位のハッシュキャッシュ(マスク結果の再利用)を仕様化。Ollama の「新規コンテンツごと」も同じ仕組みに乗せる |
| ロングラン | 記載なし | 拡張思考で 1 リクエスト 10 分超が普通。プロキシのソケットタイムアウト無効化、上流の `overloaded_error` / 429 / `retry-after` の透過を要件化 |
| ローカル NER | 4B 生成 LLM | 精度向上段としては GLiNER 系 NER モデル(ONNX)の方が決定的・高速(数十〜百 ms)で用途に合う。ゼロ依存方針は維持しつつ公式プラグインとして提供 |

---

## C. 検出仕様の過不足

### C-1. 誤検出でコーディングを壊すもの(既定値の見直し推奨)

| カテゴリ | 問題 | 推奨 |
|---|---|---|
| IP_ADDRESS | `127.0.0.1`, `0.0.0.0`, `::1`, `10/8`, `192.168/16`, `169.254/16`, ドキュメント用 `192.0.2.0/24` がマスクされると設定ファイルも README も壊れる | loopback / private / reserved を既定で除外 |
| CREDIT_CARD | Stripe テスト番号 `4242 4242 4242 4242` 等は Luhn を通る。`block` にすると決済コードの開発が止まる | 既知テスト番号を既定 allowlist に |
| POSTAL_CODE / PHONE | `123-4567` は Issue 番号・範囲表記・タイムスタンプと衝突 | 文脈(〒、TEL、住所の前後)を必須にするか既定 `warn` |
| NAME(ローマ字) | `Taro Yamada` パターンはテストフィクスチャ・変数名・コメントで頻出 | コードらしいブロック(拡張子・言語ヒント・記号密度)では NER 閾値を上げる「コンテキスト感度」を仕様化 |
| NAME(Git トレーラー) | `Author:` をマスクすると `git log` の意味が変わり blame の相談ができない | 用途次第だが既定 `warn` が妥当 |

### C-2. 抜けているカテゴリ(価値が高い順)

1. **パスワード / 認証情報(文脈付き)**: `password=`, `PASS:`, `Authorization: Basic …`, cookie / session id。API_KEY の「文脈付き高エントロピー」でどこまで拾えるか明記
2. **HOME_PATH / USERNAME**(B 参照)
3. **銀行口座**(日本の店番+口座番号)、**生年月日**、**運転免許 / パスポート番号**
4. **SNS ハンドル(`@xxx`)** — 誤検出が多いので既定 off
5. **MAC アドレス / IMEI / 端末識別子**

### C-3. 仕様に書くべき決定事項(現状読み取れない)

- 重なり解決: 辞書 > 正規表現 > NER の優先順位と、同段内の重複は「最長一致」か「先勝ち」か
- Unicode 正規化: 全角数字・全角 `@` を NFKC してから検出するか。しないなら電話番号・メールがすり抜ける
- 復元の最長一致: `[人名A]` と `[人名AA]` の順序問題
- ストリーム復元のバッファ上限: `[` はコードに頻出。保持は「最長プレースホルダ長」までで打ち切ると明記(TTFT への影響)
- 「全 21 カテゴリ」と書きつつ列挙は 13 個。全部列挙する

---

## D. プレースホルダ形式の再考

### D-1. 現行 `[メールアドレスA]` の弱点

- **Markdown リンクと衝突**: `[人名A](…)` と続くとリンク化される
- **コード内で式になる**: 配列添字・正規表現文字クラスに見える
- **トークン効率**: 日本語ラベルは 1 個あたり 6〜10 トークン。ログに IP が 1 万件あれば元より数倍膨らみコンテキストを圧迫
- **変形されやすい**: 全角化・翻訳(`[Email A]`)を既に吸収している時点で兆候が出ている

### D-2. 推奨

- モデル向け内部形式は **XML タグ風(`<pii:email id="1"/>` または `<EMAIL_1>`)か `{{EMAIL_1}}`**。日本語ラベルはユーザー表示(ログ・`test` 出力)側のみで使う。Claude は XML 風タグを最も忠実に保存する
- **system 末尾に短い注意書きブロックを任意で注入**するオプション(「`<pii:…>` は秘匿済みの値。改変せずそのまま出力に含めること」)。`Edit` の `old_string` 一致率が上がる。キャッシュ済み system ブロックの後ろに足せばキャッシュは壊れない

### D-3. `fake` モードの位置づけ

- コードを扱う場面では**構文を保つ**という決定的利点(メールがメールのまま、IP が IP のまま)
- エージェント用途では `fake` を既定にする、またはカテゴリ別に `fake` を選べるようにする価値がある
- ダミー値は予約域(`example.com`, `192.0.2.0/24`, 日本の電話なら明らかに無効な番号)から出し、元本文と衝突しないことを保証する

---

## E. 過剰・削ってよい / 簡素化できる部分

- `SIGUSR1` トグルと `/control/passthrough` は機能重複。片方で十分(残すなら `/control`)
- `x-provider` ヘッダによる振り分けは Hermes 等が送らないので実質使えない。**パスプレフィックス(`/anthropic/v1/…`, `/openai/v1/…`)か別ポート**で分ける方が確実
- セッションヘッダ 3 種(`x-pii-session-id` / `anthropic-session-id` / `x-session-id`)は A-2 のステートレス化で不要になる
- `anonymize` モード: 全履歴再送のため次ターンは再マスクされ、実質 `pseudonymize` と同じ挙動。用途(ログに残したくない等)を明確にするか統合を検討

---

## F. 細かい不整合・記載漏れ

- `CLAUDE_PII_FILTER` / `pii-filter.json` と `cloakroom` の名称混在。移行期なら注記、互換維持ならエイリアスを説明
- `warn` の audit log: 出力先・権限・ローテーション。元 PII が平文で残る点は明記必須
- `446` は IANA 未割当なので衝突はないが、Claude Code 上では生のエラー表示になることを注記
- gzip / br の扱い(`Accept-Encoding` を剥がすのか、展開して再圧縮するのか)、`Content-Length` 再計算、`x-provider` を上流へ漏らさないこと
- OpenAI 互換経由の `/v1/models` 等はフィルタ対象外パスとして既定 Anthropic 上流へ素通しされ 404 になり得る(振り分け方式の見直しとセットで)
- 「anonymize」は日本法の「匿名加工情報」を連想させる。**本ツールは仮名化であり法的な匿名加工・個人情報保護法遵守を保証しない**旨の免責を追加
- Anthropic API の商用利用は既定で学習に使われないため、本ツールは「多層防御」であって「これが無いと漏れる」わけではない、という位置づけを明記すると誠実
- `install` に対する `uninstall`、接続先が本当にプロキシを向いているか確認する `doctor` の追加
- 設定がグローバルのみ。チームで辞書・allowlist を共有するため、リポジトリ内ファイルの `include` か `PII_FILTER_CONFIG` 環境変数を追加
- `fake` モードの他カテゴリ(NAME 等)での置換値が不明瞭
- `install --for=claude-code` の後に `.env` を反映させる具体例(`source ~/.claude/.env` 等)を 1 行(B の `settings.json` 移行までの暫定)

---

## 付録: 追加すべきテストケース

- `Edit` ツール往復: プレースホルダを含む `old_string` / `new_string` が `input_json_delta` 経由で正しく復元される
- `partial_json` がプレースホルダ途中およびエスケープシーケンス(`\uXXXX`)途中で分割される
- `thinking` ブロックを含む履歴の再送でリクエスト本文がバイト単位で不変(署名維持)
- 同一履歴の 2 回送信でマスク結果がバイト単位で一致(キャッシュ前方一致の保証)
- `[人名A]` と `[人名AA]` が同一レスポンスに混在する際の復元
- loopback / private IP、Stripe テストカード番号がマスクされない
- `Host` ヘッダ偽装・カスタムヘッダ無しの `/control/*` 呼び出しが拒否される
- 上流 URL を OpenRouter / ローカル vLLM に向けた場合の `/v1/chat/completions` 往復
