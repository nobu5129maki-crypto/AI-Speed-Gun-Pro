<div align="center">
  <img src="speed-gun-icon.svg" width="200" alt="AIスピードガン ロゴ">
  <h1>AI SPEED GUN PRO</h1>
  <p>本番: <a href="https://ai-speed-gun-pro.vercel.app">ai-speed-gun-pro.vercel.app</a></p>
</div>

## 自動アップロード（GitHub / Vercel）

このリポジトリは **変更のたびに GitHub へ push し、`main` 経由で Vercel 本番へ反映** する運用です。

| 経路 | 内容 |
|------|------|
| GitHub | 作業ブランチ + `main` に push |
| Vercel | `main` push で Production 自動デプロイ（GitHub Integration） |
| CI | `.github/workflows/ci.yml` がテスト＋本番デプロイ確認 |
| エージェント | `.cursor/rules/auto-deploy.mdc` が都度アップロードを強制 |

### 手動で一括 ship

```bash
bash scripts/ship.sh "変更内容のメッセージ"
```

これでコミット → ブランチ push → `main` push（Vercel 本番）まで行います。
