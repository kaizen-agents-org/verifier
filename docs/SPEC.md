# Verifier — AI検証エージェント 仕様書 (v0.2 Draft)

> 関連文書: [DESIGN.md](./DESIGN.md)（詳細設計 — 型定義・スキーマ・Driver SDK・図解）/ [EVAL.md](./EVAL.md)（Evalハーネス実装仕様 — コーパス・fixtureアプリ・リリースゲート）

> 実装状況: 現在の実装済みMVPは [MVP.md](./MVP.md) に定義する。本文書は最終構想を含む上位仕様であり、AI Claim分解・多視点レビュー・反証・Probe DriverはまだMVP範囲外である。

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
| OSSメンテナ | bot/外部からのPRの一次検証を自動化し、人間は判定の最終確認だけしたい（untrustedコードの実行を伴うため、コンテナ隔離が整うPhase 2以降。§9参照） |
| 開発チーム | レビュー待ち時間を削減し、人間レビューを設計判断に集中させたい |

主なシナリオ:

- **S1**: `verifier check` をローカルで実行し、コミット前に自分の変更を検証する
- **S2**: PR作成時にGitHub Actionとして自動実行され、Verdictをコメント投稿する
- **S3**: AIエージェントのパイプラインに組み込み、Verdictが閾値未満なら自動で修正ループに戻す（メトリクス駆動の自律反復）。元タスクの**人間由来プロンプト**をIntent一次ソースとして渡すことを必須とする（Stage 0参照）

## 4. コア概念（用語定義）

| 用語 | 定義 |
|---|---|
| **Artifact** | 検証対象。diff、PR、ブランチ全体のいずれか |
| **Intent** | 変更が満たすべき意図。issue本文、PR説明、コミットメッセージ、明示的な仕様ファイルから抽出する |
| **Claim** | Intentを分解した検証可能な単一の主張。優先度 **must-verify**（これが壊れていたらマージ不可）/ **nice-to-verify**（検証できれば確信度が上がる）を持つ。例:「空配列を渡してもクラッシュしない」 |
| **Check** | 1つのClaimを検証する具体的手段（テスト実行、静的解析、実行観測、コードリーディング） |
| **Evidence** | Checkの実行結果。コマンド出力、スクリーンショット、テストログ、再現手順 |
| **Finding** | 検証中に発見された問題。LLMは**カテゴリ**（security / data-loss / crash / regression / logic / perf / style）と**再現Evidenceの有無**を出力し、severity（blocker / major / minor / info）はそこからルーブリック（Stage 6）で**決定的に導出**される |
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
  ├─ Stage 5  実行時観測      … 対象種別ごとのProbe Driverで実際に起動・操作・観測
  └─ Stage 6  判定統合        … Claimごとの証拠を集計し Verdict を生成
  │
出力: Verdict + Evidence台帳（Markdown / JSON）
```

### Stage 0: Intent分解

**Intentソースの優先順位（循環参照の排除）**: AI生成PRでは、PR説明を書いたのはコードを書いたのと同じエージェントであることが多い。生成者の自己申告に対して検証しても「仕様の取り違え」（issueの要求と違うものを正しく作った）は検出できない。そこでIntentソースに以下の優先順位を固定する:

1. **人間由来の一次ソース**: 元issue・ユーザー要求・仕様ファイル（S3連携では元タスクのプロンプトを入力フィールドとして必須化する）
2. **生成エージェント由来の二次ソース**: PR説明・コミットメッセージ（一次ソースの補助としてのみ使用）

一次ソースが存在せず二次ソースしかない場合、その事実自体をFinding（info）とし、確信度を下げる。Claimの抽出では一次ソースと二次ソースの**食い違い**（issueはAを要求、PR説明はBを実装したと主張）を明示的に検出し、見つかればFinding（info）として記録する。判定への実質的な影響は、一次ソース由来のmust-verify Claimが検証されない/failすることを通じて反映される（DESIGN.md参照）。

**Claim抽出と優先度付け**:

- 各Claimに検証手段（Check種別）と優先度を割り当てる:
  - **must-verify**: 変更の目的そのもの、セキュリティ・データ整合性・後方互換に関わる性質。failedならマージ不可、unverifiedなら`conditional`
  - **nice-to-verify**: 検証できれば確信度が上がるが、未検証でもマージ判断を妨げない性質（例: 検証手段のない性能特性）
- 検証手段が存在しないClaimは最初から「未検証」としてVerdictに明示する。
- Intentが不明瞭な場合（説明なしの巨大diff等）はその事実自体をFindingとし、確信度を下げる。
- **一次ソース由来のClaimが0件**の場合（一次ソースが存在しない場合を含む）は、合成must-verify Claim「変更の意図が一次ソースから特定できる」（未検証確定）を必ず生成する。二次ソースからClaimが抽出できても省略しない。これにより説明のないdiffや自己申告のみのPRが`mergeable`に到達することを構造的に防ぐ（DESIGN.md参照）。

### Stage 1: 静的検証

- プロジェクト設定を自動検出（package.json / Cargo.toml / pyproject.toml 等）し、build・typecheck・lint・基本的なsecret scanを実行する。
- **失敗の種類を区別する**: コマンドが実行できて非0終了（=コードの問題）は即blockerで、以降のStageをスキップして早期にNot mergeableを返す。コマンドが**開始できない**（コマンド不在・依存解決失敗）は環境起因の失敗であり、Findingにせず「未実行」として記録し、must-verify Claimの検証手段が全滅した場合は`inconclusive`へ倒す（判別表はDESIGN.md）。

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

- **反証ゲートはステージ番号上はStage 4だが、論理的には「再現Evidenceを持たないすべてのFinding」に適用されるゲートである**。Stage 2–3のFindingはStage 4で、Stage 5（実行時観測）由来のFindingはStage 5の直後に同じゲートを通ってからStage 6へ入る（パイプラインは厳密な直列ではなくDAG。DESIGN.md参照）。
- 反証の要否はEvidenceの性質で決まる:
  - **反証不要**: 決定的な再現Evidenceを持つFinding（テスト失敗、クラッシュ、HTTPステータス不一致、終了コード異常）。Evidence自体が再現手順であり、反証より再実行の方が強い。
  - **反証必須**: 読解のみのFinding、および**視覚差分・Vision LLM判断由来のFinding**（flakyになりやすい）。後者は「再実行による再現確認 + 別プロンプトでの画像再判定」の2段で反証する。
- 独立した反証エージェントが「このFindingは誤りである」ことの証明を試みる（コードリーディング、実際に再現コードを実行）。
- 再現できた / 反証できなかったFindingのみ採用。反証されたFindingは破棄し、その記録もEvidence台帳に残す（透明性のため）。
- これが本プロダクトの精度の生命線。**偽陽性率を人間がレビュー結果を信頼できる水準まで下げる**ことが目的。

### Stage 5: 実行時観測（中核機能）

テストやコードリーディングより強い証拠は「実際に動かして観測した結果」である。本プロダクトの差別化の中心であり、Web・デスクトップ・CLI・TUI・APIといった**あらゆる形態の成果物を同じ枠組みで実行検証できること**を目標とする。UI変更・エンドポイント変更など「テストが通っても自信が持てない」変更で特に効く。

**シナリオ生成**: diffから影響を受けるユーザーフロー・エンドポイントを特定し、操作シナリオを自動生成する。設定ファイルで明示的なシナリオ定義も可能。

**Probe Driver（プラグイン式ドライバ）**: ターゲットの種類ごとに「起動 / 操作 / 観測 / 終了」を実装するドライバを差し替える。すべてのドライバは共通インターフェース（`detect` / `launch`）を公開し、`launch` が返す driver-owned な `ProbeSession` が `interact` / `observe` / `teardown` を提供する。Orchestratorは `detect → launch → session.interact → session.observe → session.teardown` の順で呼び出し、ターゲット種別を意識せず同一に扱える。種別は自動検出（`package.json`のelectron依存、`tauri.conf.json`等）し、設定で上書き可能。

| ターゲット | ドライバ | 操作 | 観測 |
|---|---|---|---|
| **Webアプリ** | Playwright MCP + Chrome DevTools MCP | フロー実行、フォーム入力、ダイアログ処理 | コンソールエラー、ネットワーク検査、性能トレース、Lighthouse監査（CWV回帰） |
| **Electronアプリ** | PlaywrightのElectronドライバ（CDP接続） | ウィンドウ操作、メニュー、IPC経由の状態確認 | レンダラ/メインプロセスのコンソール、クラッシュ検出、スクリーンショット |
| **Tauri / WebViewアプリ** | tauri-driver（WebDriver） | WebView内操作 | WebViewコンソール、プロセス終了コード |
| **macOSネイティブ** | Accessibility API + AppleScript / `screencapture` | UI要素の操作・読み取り | スクリーンショット、Console.appログ、クラッシュレポート |
| **Windowsネイティブ** | WinAppDriver / FlaUI | UI Automation操作 | スクリーンショット、イベントログ |
| **API / サーバ** | HTTPプローブ（curl等） | リクエスト発行 | ステータス、レスポンススキーマ、認可挙動、サーバログ |
| **CLIツール** | 直接実行 | コマンド実行、stdin入力、引数の組み合わせ | 終了コード、stdout/stderr、生成ファイル、副作用（FS変更等） |
| **TUIアプリ** | pty経由（tmux / node-pty） | キー入力送信、画面遷移 | 画面バッファのスナップショット、終了コード |
| **モバイル（将来）** | Appium / Maestro | 画面操作 | スクリーンショット、デバイスログ |

GUI系ドライバで構造化された操作が難しい場合のフォールバックとして、**スクリーンショット + Vision LLM**による画面状態の検証（「エラーダイアログが出ていないか」「期待する画面に遷移したか」）を全ドライバ共通で提供する。

**差分観測**: ベースブランチと変更後の両環境で同一シナリオを実行し、差分を取る。

- スクリーンショットの視覚差分（意図しないUI崩れ）
- コンソールエラー・警告の**新規発生**（既存のノイズと区別する）
- ネットワークレスポンスの差分（ステータス、スキーマ、新規の失敗リクエスト）
- 性能指標（LCP / INP / トレース）の劣化

**Evidence**: スクリーンショット、コンソールログ、ネットワーク記録（HAR）、性能トレースをすべて `.verifier/runs/<id>/` に保存し、レポートから参照する。

### Stage 6: 判定統合

#### Severityルーブリック（決定的導出）

severityをLLMの裁量にすると「判定は決定的ルール」が骨抜きになる。LLMが出力するのは**カテゴリ**と**再現Evidenceの有無**までとし、severityは以下の表から機械的に導出する:

| 条件 | severity |
|---|---|
| カテゴリが security / data-loss / crash / regression で、**再現Evidenceあり** | **blocker** |
| must-verify Claimの `failed`（定義上、再現Evidenceを伴う） | **blocker** |
| カテゴリが logic / perf で再現Evidenceあり、または security 等で再現Evidenceなし（読解のみ） | **major** |
| 再現Evidenceのない logic / perf、および style 全般 | **minor** |
| 問題ではないが判断材料になる観察（Intent不明瞭、一次ソース欠如等） | **info** |

再現Evidenceのないsecurity Findingがblockerにならないのは意図的な設計である: 「読解だけの指摘はどれだけ深刻に見えても人間の確認対象（major → conditional）であり、マージを機械的に拒否する権限（blocker）は実証された問題だけが持つ」。これにより偽陽性によるマージ妨害を防ぐ。

#### Verdict決定ルール

- Claimごとに証拠を集計: `verified` / `failed` / `unverified`
- 決定ルール（上から順に評価）:
  1. blocker Findingが1つでもある（must-verify Claimのfailedを含む）→ `not_mergeable`
  2. 環境起因の失敗により、あるmust-verify Claimの検証手段がすべて実行できなかった → `inconclusive`
  3. major Findingがある、または **must-verify** Claimにunverifiedがある → `conditional`（解消条件を列挙）
  4. 上記以外（全must-verifyがverified、blocker/majorなし）→ `mergeable`
- **nice-to-verifyのunverifiedは`mergeable`を妨げない**。妨げる設計にすると、検証手段のない性質（性能特性等）が常に存在するため事実上すべてのPRが`conditional`になり、「マージ可否に答える」という価値が失われる。未検証であることはレポートに必ず明示し、確信度に反映する。
- 確信度は「検証が**完了した**（verified / failed）Claimの割合（must-verifyを重み付け） × Check手段の強度（実行 > テスト > 読解）− Finding数に応じた減点」から決定的に算出する。確信度の意味は「判定がどれだけ強い証拠に裏づけられているか」であり、mergeableへの傾きではない（failedも検証完了として扱う）。算出式はDESIGN.mdで定義し、`verdict.schema.json` とともにバージョン管理する。

## 6. 出力フォーマット

### Verdictレポート（Markdown — PRコメント / CLI出力）

```markdown
## Verdict: ⚠️ Conditional (confidence: 70/100)

**マージ条件**: 下記 major finding 1件の解消、または明示的な許容判断

### Claims (must-verify 3/3 verified / nice-to-verify 0/1)
| Claim | 優先度 | 結果 | 証拠 |
|---|---|---|---|
| 空配列入力でクラッシュしない | must | ✅ verified | 生成テスト3件パス [E-12] |
| 既存APIの後方互換を維持 | must | ✅ verified | 呼び出し元14箇所を読解、全テストパス [E-7] |
| 認証なしでアクセス不可 | must | ✅ verified | curlで再現: 全エンドポイント401 [E-15] |
| パフォーマンス劣化なし | nice | ⬜ unverified | ベンチマーク手段なし |

### Findings (反証を生き延びた 2件 / 検出7件中5件は反証により破棄)
1. **[major]** `cache.ts:67` キャッシュ無効化がマルチバイトキーで効かない（logic・再現あり）
   再現: 生成テストで日本語キーの更新が反映されないことを確認 [E-18]
2. **[minor]** `utils.ts:18` リトライ上限到達時のエラーが握りつぶされる（logic・読解のみ、再現コード作成は失敗）
```

参考: 仮にClaim「認証なしでアクセス不可」が`failed`（curlで200が返る等）なら、severityルーブリックにより自動的にblockerとなり、Verdictは`not_mergeable`になる。

### JSON出力（機械連携用）

S3（自律ループ組み込み）のため、全VerdictはJSONでも出力する。スキーマは `verdict.schema.json` として定義・バージョン管理する。

## 7. インターフェース

### MVP: CLI

```bash
verifier check                       # 作業ツリーの未コミット変更を検証
verifier check --base main           # mainとの差分を検証
verifier check --pr 123              # GitHub PRを検証
verifier check --intent issue#45     # 意図の明示指定（issue / ファイル / テキスト）
verifier check --json                # JSON出力
verifier check --stages 0,1,2,3,4    # Stage 5（実行観測）を除外 等
verifier check --reuse-claims <id>   # 過去実行のClaimセットを固定して再実行（判定差分の切り分け）
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
   ├── Probe Drivers    … ターゲット種別ごとの実行観測プラグイン（Stage 5）
   │     web / electron / tauri / macos-native / windows-native / api / cli / tui
   ├── Evidence Store   … .verifier/runs/<id>/ に全Evidence（ログ・出力・スクリーンショット）を保存
   └── Reporter         … Markdown / JSON / GitHubコメント生成
```

技術選定（MVP）:

- **言語**: TypeScript（Node.js 22+）
- **LLM**: Claude API（Agent SDK）。レンズレビュー・反証は並列サブエージェント、判定統合はLLMを使わず決定的ロジック
- **実行隔離**: git worktree + プロジェクトのローカル環境（**trustedコード限定**。untrusted対応はPhase 2のコンテナ隔離が前提。§9の信頼レベル参照）
- **実行時観測**: Probe Driver SDK（公開インターフェース）。同梱ドライバは Playwright MCP / Chrome DevTools MCP（web）、Playwright Electronドライバ、tauri-driver、node-pty（tui）、HTTP/CLI直接実行。サードパーティがドライバを追加実装できる

設計上の重要判断:

- **判定はコードで、発見はLLMで**。Verdict決定・確信度算出は決定的ルールにし、再現性と説明可能性を保証する。LLMは「Claimの抽出」「Findingの発見」「反証」という発散的タスクのみ担当する。
- **生成テストはリポジトリを汚さない**。一時環境でのみ実行し、有用なものは提案として出力する。
- **Evidenceはすべてローカル保存**。コードを外部サービスに保存しない（LLM API呼び出しを除く）。

## 9. 非機能要件

| 項目 | 目標 |
|---|---|
| 実行時間 | 標準的なPR（〜500行diff）でStage 0–4を10分以内。Stage 5は1シナリオ5分・全体20分の時間予算を持ち、超過したシナリオは中断して「未検証」に倒す。差分観測のベース環境はビルドキャッシュを再利用して2重ビルドのコストを抑える |
| 偽陽性率 | 報告Findingのうち人間が「誤検出」と判断する割合 < 10%（反証Stageで担保） |
| 再現性 | **統計的目標**: 同一入力・同一設定でN=5回実行し、5回ともVerdict区分が一致したケースの割合 ≥ 95%（§11.4・EVAL.mdで実測）。Claim抽出・Finding発見はLLM由来で非決定的なため100%は保証できない。判定ロジック（Stage 6）自体は決定的であり、`--reuse-claims <run-id>` で過去実行のClaimセットを固定して再実行すれば判定差分の原因を切り分けられる |
| コスト | 1回の検証あたりのLLMコストを計測しレポートに表示する |
| 安全性 | 下記「信頼レベルと実行ポリシー」参照 |
| 失敗の明示 | あるStageが実行不能な場合、エラーで止めず「未検証」としてVerdictに反映する |

### 信頼レベルと実行ポリシー

検証は信頼できないコードの実行を伴う（Stage 2/5）。対象コードの由来で実行ポリシーを分ける:

| 信頼レベル | 対象 | 実行環境 | 対応Phase |
|---|---|---|---|
| **trusted** | 自分・チームメンバー・自組織のエージェントが書いた変更 | git worktree + ローカル環境 | Phase 1 (MVP) |
| **untrusted** | 外部コントリビュータ・botのPR（S2のOSSユースケース） | コンテナ隔離が**必須**。未整備ならStage 2/5をスキップし`inconclusive`を返す | Phase 2 |

MVPがtrustedのみ対応であることは制約として明記する。worktreeはファイル分離であってプロセス・権限分離ではないため、untrustedコードの隔離としては成立しない。

**ネットワークポリシー（許可リスト方式）**: 「デフォルト全遮断」はnpm install等と両立しないため、用途別の許可リストとする。

- 許可: パッケージレジストリ（npm / PyPI / crates.io 等）、localhost（Stage 5のプローブ対象）、LLM API
- 遮断: 上記以外のすべての外部通信（検証対象コードからの任意の外部送信を含む）。遮断した通信の試行はEvidenceとして記録する（不審な外部送信はそれ自体がsecurity Finding）

## 10. ロードマップ

### Phase 1 — MVP（CLI・コア検証）
- Stage 0/1/2(既存テストのみ)/3/4/5(cli・apiドライバのみ)/6 + Markdown/JSONレポート
- Probe Driver: **cli / api**（実装コストが低く、即座に「実行ベースの証拠」を出せる）
- 最小Evalコーパス（seeded-bug fixture 10件程度）でリリース判定する体制を最初から敷く
- TypeScript/Node.jsプロジェクト対応のみ
- 成功条件: 自分のPRに対して有用なVerdictが出ること（ドッグフーディング）

### Phase 2 — 実行時観測の本格化
- Probe Driver: **web**（Playwright MCP + Chrome DevTools MCP、差分観測）、**electron**、**tui**
- Stage 2のエッジケーステスト生成、カバレッジ差分
- コンテナ隔離 + ネットワーク許可リスト（untrusted PR対応＝S2ユースケースの前提条件）
- GitHub Action連携
- Probe Driver SDKの公開（サードパーティドライバ受け入れ）

### Phase 3 — 全ターゲット網羅と自律ループ
- Probe Driver: **tauri / macos-native / windows-native**、Vision LLMフォールバック
- Verdict閾値による自動修正ループ連携（S3）
- GitHub App（コメント投稿、Commit Status、branch protection連携）
- Verdict履歴の蓄積と、人間の最終判断との一致率トラッキング（キャリブレーション）

## 11. Verifier自身の検証（Evalハーネス）

Verifierは「判定」を売るプロダクトであり、その判定の正しさ自体が検証されていなければ信頼に値しない。「検証者を誰が検証するのか」への答えを最初から仕組みとして組み込む。実装仕様（コーパス形式・fixtureアプリ構成・メトリクス算出・リリースゲート）は [EVAL.md](./EVAL.md) に定義する。

### 11.1 ベンチマークコーパス

- **Seeded-bugコーパス**: 正常なコードベースに既知のバグ（認可漏れ、off-by-one、回帰、リソースリーク等）を意図的に注入したfixture PR群。正解ラベル（期待Verdict + 期待Finding）つき。
- **Golden PRコーパス**: 人間の判断が確定している実PR（マージされ安定稼働 = mergeable、revertされた = not_mergeable）。
- **ラベルノイズの扱い**: Golden PRのラベルは本質的にノイズを含む（マージされたバグは存在するし、revertが当時の判断として不当だったとは限らない）。よって (a) 正解が構成的に既知なseeded-bugコーパスを主、Golden PRを従とする、(b) Golden PRはrevert理由が記録されているもの・複数人がレビューしたもののみ採用する、(c) KPI閾値はノイズ込みの値として設定する。
- リリース前にコーパス全体へVerifierを実行し、**検出率（recall）・偽陽性率・Verdict一致率**を計測する。§12のKPIはこのハーネスで実測する。閾値未達ならリリースしない。

### 11.2 Probe Driverの検証（fixtureアプリ）

各ドライバは、既知の欠陥を仕込んだ**fixtureアプリ**に対して期待どおりのEvidenceを生成できることをCIで検証する:

| ドライバ | fixtureアプリ | 仕込む欠陥の例 |
|---|---|---|
| web | 小規模SPA | コンソールエラー、404リクエスト、CWV劣化、UI崩れ |
| electron / tauri | 最小デスクトップアプリ | レンダラクラッシュ、IPCエラー、ウィンドウ表示不全 |
| macos-native / windows-native | 最小ネイティブアプリ | 起動クラッシュ、ボタン無反応、エラーダイアログ |
| cli | 小さなCLIツール | 異常終了コード、stderr汚染、ファイル書き込み漏れ |
| tui | 最小TUIアプリ | キー入力無視、画面描画崩れ、ハング |
| api | 小さなHTTPサーバ | 認可漏れ、スキーマ違反、5xx |

「ドライバが欠陥を検出できること」と「正常なfixtureで偽陽性を出さないこと」の両方をテストする。

### 11.3 E2Eテストとドッグフーディング

- Verifier自身のCIで、fixtureリポジトリに対する `verifier check` をE2E実行し、Verdict区分・Claim結果・レポート構造をスナップショットテストする。
- VerifierリポジトリのPRは必ずVerifier自身で検証する（S2構成のセルフホスト）。
- 運用中の判定と人間の最終判断の不一致ケースをベンチマークコーパスへ還流する（キャリブレーションループ）。

### 11.4 再現性テスト

同一コーパスに対してN回実行し、Verdict区分の一致率を計測する。LLM出力の揺らぎが判定に漏れていないこと（§9の再現性要件）を実測で担保する。

## 12. 成功指標（KPI）

1. **判定一致率**: Verifierの`mergeable`判定と、人間の最終マージ判断の一致率 ≥ 90%
2. **偽陽性率**: 報告Findingの誤検出率 < 10%
3. **検証時間の削減**: 導入前後でのPRマージまでのレビュー時間
4. **未検証の可視化率**: Claimのうち「unverified」と明示できた割合（沈黙ゼロ）
5. **ドライバ網羅率**: 対象プロジェクトのターゲット種別のうち、実行観測まで到達できた割合

## 13. リスクと対策

| リスク | 対策 |
|---|---|
| LLMレビューの偽陽性で信頼を失う | Stage 4の反証を必須化。再現シナリオのないFindingは出力禁止 |
| 「AIがAIを検証する」循環で同じ盲点を共有する | レンズの多様化、実行ベースのEvidence（テスト・観測）を読解より優先 |
| 検証コスト（時間・API料金）が高すぎる | Stage 1での早期打ち切り、diff規模に応じたStage選択、コスト表示 |
| 環境構築できないリポジトリで動かない | `inconclusive`を正直に返す。ゼロコンフィグ + 設定ファイルで段階的に対応 |
| GUI自動化（特にネイティブアプリ）のflakinessで観測が安定しない | リトライ + fixtureアプリでのドライバCI（§11.2）。不安定な観測はEvidenceにせず「未検証」へ倒す |
| Verdictへの過信（人間が思考停止する） | 確信度と未検証項目を常に明示。`conditional`を安易に`mergeable`に倒さない |
