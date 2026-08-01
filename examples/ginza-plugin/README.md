# ginza-plugin — GiNZA 日本語 NER アダプタ

[GiNZA](https://megagonlabs.github.io/ginza/) を使って日本語テキストから人名・組織名・学校名を検出する cloakroom プラグインです。

## 仕組み

`plugin.mjs` が Node.js 子プロセスとして `detect.py` を呼び出し、標準入力にテキストを渡します。`detect.py` は GiNZA（spaCy ベース）で固有表現を抽出し、JSON 配列を標準出力に返します。`plugin.mjs` はその結果を `FilterPluginMatch` 形式に変換して cloakroom に返します。

本体コードへの依存を一切追加せず、Python 側の依存は独立した仮想環境で管理できます。

## セットアップ

### Python 環境

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install ginza ja-ginza
```

### 動作確認

```bash
echo "田中太郎は株式会社サンプルに勤めています。" | python3 detect.py
# => [{"text": "田中太郎", "start": 0, "end": 4, "category": "NAME"}, ...]
```

## cloakroom への組み込み

`.cloakroom.json` の `plugins` に追加します。

```json
{
  "piiFilter": {
    "plugins": ["./examples/ginza-plugin/plugin.mjs"]
  }
}
```

`python3` コマンドが PATH に含まれ、`ja_ginza` モデルがインストール済みであることを確認してください。

## 検出カテゴリ

| GiNZA ラベル | cloakroom カテゴリ |
|---|---|
| Person / PERSON | NAME |
| Corporation / ORG / Organization | ORG |
| School / SCHOOL | SCHOOL |

## タイムアウト

デフォルトは 5,000ms です。重いモデルを使う場合は `plugin.mjs` の `timeout` を調整してください。
