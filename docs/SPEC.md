# Verifier — AI検証エージェント 仕様書 (v0.1 Draft)

## 1. 背景と課題

生成AIによってコードを書くコストはゼロに近づいた。その結果、ソフトウェア開発のボトルネックは「書くこと」から「**この変更を自信を持ってマージできるか判定すること**」へ移動した（参考: [ボトルネックの移動とソフトウェアの未来](https://zenn.dev/hiraoku/articles/bottleneck-shift-future-of-software)）。

Bunプロジェクトの事例では、自動エージェントがテスト付きPRを量産する一方、メンテナの仕事は「修正すること」から「マージ判定」に変わった。つまり今、本当に不足しているのは**検証のスループット**である。

既存ツールの限界:

- CI（テスト・lint）は「既知の性質」しか検証できない。変更の**意図**に対する正しさは見ない。
- AIコードレビューツール（CodeRabbit等）は「指摘リスト」を出すが、**マージ可否の判断**は人間に丸投げする。指摘が増えるほど人間の検証負荷はむしろ増える。
- どちらも「証拠」を構造化して残さないため、判断の根拠が再利用できない。

## 2. プロダクトコンセプト

> **「このPR、マージして大丈夫？」に、証拠つきで答えるAIエージェント。**

Verifierは、変更（diff/PR）と意図（issue・PR説明・仕様）を入力として受け取り、**閉じた検証ループ**（テスト → レビュー → 実行観測 → 反証）を自律実行し、最終的に1つの**Verdict（判定）**を返す。

設計原則:

1. **指摘ではなく判定を返す** — 出力は「Mergeable / Mergeable with conditions / Not mergeable」+ 確信度。指摘リストはその根拠（証拠）として添付される。
2. **すべての主張に証拠をつける** — 「バグがありそう」ではなく「この入力で実行したらこう失敗した（再現手順つき）」。検証できなかった項目は「未検証」と明示する。沈黙による見落としを作らない。
3. **反証で精度を担保する** — AIレビューの最大の問題は偽陽性。すべてのfindingは独立した反証エージェントによる攻撃を生き延びたものだけが報告される。
4. **意図に対して検証する** — テストが通ることと、issueが解決されたことは別。意図を検証可能なチェックリストに変換し、1項目ずつ証拠を集める。

## 3. ターゲットユーザーとユースケース

| ユーザー | ユースケース |
|---|---|
| AIエージェントを使う個人開発者 | Claude Code等が生成した変更を、自分で全部読まずにマージ判断したい |
| OSSメンテナ | bot/外部からのPRの一次検証を自動化し、人間は判定の最終確認だけしたい |
| 開発チーム | レビュー待ち時間を削減し、人間レビューを設計判断に集中させたい |

主なシナリオ:

- **S1**: `verifier check` をローカルで実行し、コミット前に自分の変更を検証する
- **S2**: PR作成時にGitHub Actionとして自動実行され、Verdictをコメント投稿する
- **S3**: AIエージェントのパイプラインに組み込み、Verdictが閾値未満なら自動で修正ループに戻す（メトリクス駆動の自律反復）

## 4. コア概念（用語定義）

| 用語 | 定義 |
|---|---|
| **Artifact** | 検証対象。diff、PR、ブランチ全体のいずれか |
| **Intent** | 変更が満たすべき意図。issue本文、PR説明、コミットメッセージ、明示的な仕様ファイルから抽出する |
| **Claim** | Intentを分解した検証可能な単一の主張。例:「空配列を渡してもクラッシュしない」 |
| **Check** | 1つのClaimを検証する具体的手段（テスト実行、静的解析、実行観測、コードリーディング） |
| **Evidence** | Checkの実行結果。コマンド出力、スクリーンショット、テストログ、再現手順 |
| **Finding** | 検証中に発見された問題。severity（blocker / major / minor / info）を持つ |
| **Verdict** | 最終判定。`mergeable` / `conditional` / `not_mergeable` / `inconclusive` + 確信度(0–100) + Evidence台帳 |

## 5. 検証パイプライン（コア機能）

```
入力: Artifact + Intent
  │
  ├─ Stage 0  Intent分解      … 意図 → Claimチェックリスト
  ├─ Stage 1  静的検証        … build / typecheck / lint / secret scan
  ├─ Stage 2  動的検証        … 既存テスト + AIがエッジケーステストを生成・実行
  ├─ Stage 3  多視点レビュー  … 正しさ / セキュリティ / 回帰 / 性能 の独立エージェント
  ├─ Stage 4  反証            … 全Findingを反証エージェントが攻撃、生存したものだけ採用
  ├─ Stage 5  実行時観測      … 実際にアプリを起動し変更フローを操作（任意）
  └─ Stage 6  判定統合        … Claimごとの証拠を集計し Verdict を生成
  │
出力: Verdict + Evidence台帳（Markdown / JSON）
```

### Stage 0: Intent分解

- PR説明・リンクされたissue・diffから「この変更が満たすべき性質」をClaimのリストとして抽出する。
- 各Claimに検証手段（Check種別）を割り当てる。検証手段が存在しないClaimは「未検証」として最初からVerdictに明示する。
- Intentが不明瞭な場合（説明なしの巨大diff等）はその事実自体をFindingとし、確信度を下げる。

### Stage 1: 静的検証

- プロジェクト設定を自動検出（package.json / Cargo.toml / pyproject.toml 等）し、build・typecheck・lint・基本的なsecret scanを実行する。
- 失敗は即blocker。このStageが通らない場合、以降のStageはスキップして早期にNot mergeableを返せる。

### Stage 2: 動的検証

- 既存テストスイートを実行し、ベースブランチとの差分（新規失敗・新規スキップ）を検出する。
- AIエージェントが**変更箇所に対するエッジケーステスト**を生成して実行する（境界値、空入力、並行、エラーパス）。生成テストは一時環境で実行され、リポジトリには書き込まない（採用したい場合のみ提案として出力）。
- カバレッジ差分を計測し、「変更行のうちテストが触れていない割合」をEvidenceに含める。

### Stage 3: 多視点レビュー

- 独立した4つのレンズで並列レビューする。各レンズは互いの結果を見ない（多様性で見落としを減らす）:
  - **Correctness**: ロジック誤り、off-by-one、null/undefined、エラーハンドリング漏れ
  - **Security**: インジェクション、認可漏れ、秘匿情報、依存の脆弱性
  - **Regression**: 既存の呼び出し元・公開APIへの影響、後方互換性
  - **Performance**: N+1、不要な再計算、メモリリーク（明白なもののみ）
- 各レンズはFindingを「該当コード位置 + 問題となる具体的シナリオ」つきで返す。シナリオを書けないFindingは出力できない（曖昧な指摘の禁止）。

### Stage 4: 反証（Adversarial Verification）

- Stage 2–3の全Findingに対し、独立した反証エージェントが「このFindingは誤りである」ことの証明を試みる（コードリーディング、実際に再現コードを実行）。
- 再現できた / 反証できなかったFindingのみ採用。反証されたFindingは破棄し、その記録もEvidence台帳に残す（透明性のため）。
- これが本プロダクトの精度の生命線。**偽陽性率を人間がレビュー結果を信頼できる水準まで下げる**ことが目的。

### Stage 5: 実行時観測（任意・設定で有効化）

- アプリを実際に起動し、変更に関係するユーザーフローをブラウザ/CLI操作で実行して観測する（Playwright等）。
- スクリーンショット・コンソールエラー・HTTPエラーをEvidenceとして記録する。
- Web UIの変更、APIエンドポイントの変更など「テストでは自信が持てない」変更で特に有効。

### Stage 6: 判定統合

- Claimごとに証拠を集計: `verified` / `failed` / `unverified`
- Verdict決定ルール（決定的なルールベース。LLMの気分で判定が揺れないようにする）:
  - blocker Findingが1つでもあれば `not_mergeable`
  - 全Claimがverifiedかつmajor Findingなし → `mergeable`
  - major Findingあり、またはunverified Claimあり → `conditional`（条件を列挙）
  - 検証手段が実行できなかった（環境構築失敗等）→ `inconclusive`
- 確信度は「検証できたClaimの割合 × Check手段の強度（実行 > テスト > 読解）」から決定的に算出する。

## 6. 出力フォーマット

### Verdictレポート（Markdown — PRコメント / CLI出力）

```markdown
## Verdict: ⚠️ Conditional (confidence: 72/100)

**マージ条件**: 下記 major finding 1件の解消、または明示的な許容判断

### Claims (4/5 verified)
| Claim | 結果 | 証拠 |
|---|---|---|
| 空配列入力でクラッシュしない | ✅ verified | 生成テスト3件パス [E-12] |
| 既存APIの後方互換を維持 | ✅ verified | 呼び出し元14箇所を読解、全テストパス [E-7] |
| 認証なしでアクセス不可 | ❌ failed | curlで再現: 401でなく200が返る [E-15] |
| パフォーマンス劣化なし | ⬜ unverified | ベンチマーク手段なし |

### Findings (反証を生き延びた 2件 / 検出7件中5件は反証により破棄)
1. **[major]** `auth.ts:42` 認可チェックがGETのみでPOSTに適用されない
   再現: `curl -X POST ...` → 200 [E-15]
2. **[minor]** `utils.ts:18` エラーメッセージにスタックトレースが漏れる
```

### JSON出力（機械連携用）

S3（自律ループ組み込み）のため、全VerdictはJSONでも出力する。スキーマは `verdict.schema.json` として定義・バージョン管理する。

## 7. インターフェース

### MVP: CLI

```bash
verifier check                       # 作業ツリーの未コミット変更を検証
verifier check --base main           # mainとの差分を検証
verifier check --pr 123              # GitHub PRを検証
verifier check --intent issue#45     # 意図の明示指定
verifier check --json                # JSON出力
verifier check --stages 0,1,2,3,4    # Stage 5（実行観測）を除外 等
```

設定は `verifier.config.{json,ts}`（実行コマンド、テストコマンド、Stage 5の起動手順、確信度閾値）。未設定でも自動検出でゼロコンフィグ動作する。

### Phase 2: GitHub App / Action

- PR作成・更新時に自動実行し、Verdictをコメント投稿（更新時は同一コメントを編集）
- Commit Statusで `verifier/verdict` を報告し、branch protectionに組み込める

## 8. アーキテクチャ

```
CLI / GitHub Action
   │
Orchestrator（パイプライン制御・決定的ロジック）
   │
   ├── Sandbox Runner   … git worktree + 一時環境でビルド/テスト/生成テストを実行
   ├── Agent Pool       … Claude Agent SDK。レンズ別レビュー・反証・Intent分解を並列実行
   ├── Evidence Store   … .verifier/runs/<id>/ に全Evidence（ログ・出力・スクリーンショット）を保存
   └── Reporter         … Markdown / JSON / GitHubコメント生成
```

技術選定（MVP）:

- **言語**: TypeScript（Node.js 22+）
- **LLM**: Claude API（Agent SDK）。レンズレビュー・反証は並列サブエージェント、判定統合はLLMを使わず決定的ロジック
- **実行隔離**: git worktree + プロジェクトのローカル環境（Phase 2でコンテナ化）
- **実行時観測**: Playwright（Stage 5）

設計上の重要判断:

- **判定はコードで、発見はLLMで**。Verdict決定・確信度算出は決定的ルールにし、再現性と説明可能性を保証する。LLMは「Claimの抽出」「Findingの発見」「反証」という発散的タスクのみ担当する。
- **生成テストはリポジトリを汚さない**。一時環境でのみ実行し、有用なものは提案として出力する。
- **Evidenceはすべてローカル保存**。コードを外部サービスに保存しない（LLM API呼び出しを除く）。

## 9. 非機能要件

| 項目 | 目標 |
|---|---|
| 実行時間 | 標準的なPR（〜500行diff）でStage 0–4を10分以内 |
| 偽陽性率 | 報告Findingのうち人間が「誤検出」と判断する割合 < 10%（反証Stageで担保） |
| 再現性 | 同一入力・同一設定での再実行でVerdict区分が一致する |
| コスト | 1回の検証あたりのLLMコストを計測しレポートに表示する |
| 安全性 | 検証対象コードの実行はsandbox内に限定。ネットワークアクセスはデフォルト遮断 |
| 失敗の明示 | あるStageが実行不能な場合、エラーで止めず「未検証」としてVerdictに反映する |

## 10. ロードマップ

### Phase 1 — MVP（CLI・コア検証）
- Stage 0/1/2(既存テストのみ)/3/4/6 + Markdownレポート
- TypeScript/Node.jsプロジェクト対応のみ
- 成功条件: 自分のPRに対して有用なVerdictが出ること（ドッグフーディング）

### Phase 2 — 検証の深化
- Stage 2のエッジケーステスト生成、カバレッジ差分
- Stage 5（Playwright実行観測）
- JSON出力 + GitHub Action

### Phase 3 — 自律ループとチーム利用
- Verdict閾値による自動修正ループ連携（S3）
- GitHub App（コメント投稿、Commit Status、branch protection連携）
- Verdict履歴の蓄積と、人間の最終判断との一致率トラッキング（キャリブレーション）

## 11. 成功指標（KPI）

1. **判定一致率**: Verifierの`mergeable`判定と、人間の最終マージ判断の一致率 ≥ 90%
2. **偽陽性率**: 報告Findingの誤検出率 < 10%
3. **検証時間の削減**: 導入前後でのPRマージまでのレビュー時間
4. **未検証の可視化率**: Claimのうち「unverified」と明示できた割合（沈黙ゼロ）

## 12. リスクと対策

| リスク | 対策 |
|---|---|
| LLMレビューの偽陽性で信頼を失う | Stage 4の反証を必須化。再現シナリオのないFindingは出力禁止 |
| 「AIがAIを検証する」循環で同じ盲点を共有する | レンズの多様化、実行ベースのEvidence（テスト・観測）を読解より優先 |
| 検証コスト（時間・API料金）が高すぎる | Stage 1での早期打ち切り、diff規模に応じたStage選択、コスト表示 |
| 環境構築できないリポジトリで動かない | `inconclusive`を正直に返す。ゼロコンフィグ + 設定ファイルで段階的に対応 |
| Verdictへの過信（人間が思考停止する） | 確信度と未検証項目を常に明示。`conditional`を安易に`mergeable`に倒さない |
