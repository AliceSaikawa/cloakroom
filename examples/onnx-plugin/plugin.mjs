import { InferenceSession, Tensor } from 'onnxruntime-node'

// モデルパスは設定で指定: { "plugins": ["./examples/onnx-plugin/plugin.mjs"] }
// モデルファイルは別途ダウンロードが必要（README参照）
const MODEL_PATH = process.env.CLOAKROOM_ONNX_MODEL ?? './ner-model.onnx'

let session = null
async function getSession() {
  if (!session) session = await InferenceSession.create(MODEL_PATH)
  return session
}

export default {
  name: 'onnx-ner',
  async detect(text) {
    // スケルトン: 実際のトークナイザーとモデル出力処理はモデルに依存
    // この関数はモデルが用意されている場合にのみ動作する
    try {
      // const sess = await getSession()
      // 1. テキストをトークナイズ（モデルごとにトークナイザーが異なる）
      // 2. input_ids / attention_mask テンソルを作成
      // 3. sess.run({ input_ids: ..., attention_mask: ... }) で推論
      // 4. ロジットからエンティティスパンを復元して FilterPluginMatch[] を返す
      // ... ONNX推論ロジック（モデル依存）...
      return []  // スケルトンは常に空を返す
    } catch {
      return []
    }
  },
}
