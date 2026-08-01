# examples — cloakroom プラグインサンプル

本体のゼロ依存方針を維持しつつ、追加の NER（固有表現認識）機能を組み込むためのサンプルプラグイン集です。

## プラグイン一覧

| フォルダ | 方式 | 言語 | 状態 |
|---|---|---|---|
| `ginza-plugin/` | GiNZA（spaCy）経由の日本語 NER | Python + Node.js | 動作可能 |
| `onnx-plugin/` | ONNX Runtime による推論 | Node.js のみ | スケルトン |

## ginza-plugin

Python の GiNZA ライブラリを子プロセスとして呼び出します。Python 環境と `ja_ginza` モデルが必要です。

**向いているケース**
- 日本語テキストの NER 精度を最優先したい
- Python 環境をすでに用意できる

セットアップ手順: `ginza-plugin/README.md` を参照してください。

## onnx-plugin

`onnxruntime-node` で ONNX 形式のモデルを直接 Node.js から実行します。現状はスケルトンであり、モデルファイルとトークナイザー実装が別途必要です。

**向いているケース**
- Python を使わず純粋な Node.js 環境で動かしたい
- 既存の ONNX NER モデルがある

セットアップ手順: `onnx-plugin/README.md` を参照してください。

## 共通のプラグインインターフェース

どちらのプラグインも `src/types.ts` の `FilterPlugin` インターフェースに準拠しています。

```ts
type FilterPlugin = {
  name: string
  detect(text: string): FilterPluginMatch[] | Promise<FilterPluginMatch[]>
}

type FilterPluginMatch = {
  start: number
  end: number
  value: string
  category?: PIICategory
  confidence?: number
}
```

独自プラグインを作成する場合は、このインターフェースを実装して `.cloakroom.json` の `piiFilter.plugins` に追加してください。
