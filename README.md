<div align="center">
  <img src="speed-gun-icon.svg" width="160" alt="AIスピードガン ロゴ">
  <h1>AI SPEED GUN PRO</h1>
  <p><b>PRO FIELD v6.0</b> — スマホで高精度に球速を測るスピードガン</p>
</div>

## 使い方
1. https://ai-speed-gun-pro.vercel.app を開く（ホーム画面追加推奨）
2. 距離・画角を設定
3. 計測スタート → ガイド枠を左右に横切る（指や物でも動作確認できます）

## 検出方式（v6.0）
- `detector.js`: 背景モデル＋ノイズ適応しきい値＋前景重心追跡（ブラウザ / Node 共用）
- 手ブレ・パン・露出変化は「画面全体の変化」として背景をリセットし誤検知を防止
- `?debug=1` を付けて開くと検出状態（種別 / しきい値 / 前景率 / 点数）を表示
- テスト: `node test-cross-catch.mjs`

## デプロイ
`bash scripts/ship.sh "メッセージ"` で GitHub + Vercel 本番へ反映
