# onnx-plugin — ONNX NER アダプタ（スケルトン）

`onnxruntime-node` を使って ONNX 形式の NER モデルを cloakroom プラグインとして組み込むためのボイラープレートです。

## このプラグインについて

`plugin.mjs` はスケルトンです。モデルファイルとトークナイザーが別途必要であり、現時点では常に空の結果を返します。ONNX NER モデルを持っている場合に、このスケルトンを出発点として実装してください。

ginza-plugin（Python/GiNZA）と比べて純粋な Node.js 環境で完結するため、Python 環境を用意できないケースに向いています。

## 必要なもの

| 項目 | 備考 |
|---|---|
| `onnxruntime-node` | `npm install onnxruntime-node` |
| ONNX モデルファイル | 別途ダウンロードまたはエクスポートが必要 |
| トークナイザー実装 | モデルに合わせて `plugin.mjs` に実装する |

## モデルファイルの準備

ONNX NER モデルは Hugging Face などから取得できます。例として `bert-base-japanese` 系のモデルを ONNX にエクスポートする場合:

```bash
pip install optimum[exporters]
optimum-cli export onnx --model <モデル名> --task token-classification ./ner-model-dir/
```

エクスポート後のモデルパスを環境変数で指定します:

```bash
export CLOAKROOM_ONNX_MODEL=/path/to/ner-model.onnx
```

## cloakroom への組み込み

`.cloakroom.json` の `plugins` に追加します:

```json
{
  "piiFilter": {
    "plugins": ["./examples/onnx-plugin/plugin.mjs"]
  }
}
```

## 実装ガイド

`plugin.mjs` の `detect` 関数内に以下を実装してください:

1. テキストをモデルのトークナイザーでトークン化する
2. `input_ids`・`attention_mask` テンソルを作成して `sess.run()` に渡す
3. 出力ロジットから BIO/IOB タグを復元してエンティティスパンを特定する
4. 各スパンを `{ value, start, end, category, confidence }` 形式で返す

`FilterPluginMatch` の型定義は `src/types.ts` を参照してください。
