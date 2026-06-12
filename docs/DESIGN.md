# Verifier 詳細設計書 (v0.1)

[SPEC.md](./SPEC.md) の要求を実装に落とすための設計文書。対象はPhase 1 (MVP) + Phase 2の骨格。Evalハーネスの詳細は [EVAL.md](./EVAL.md) を参照。

## 1. コンポーネント構成と依存関係

```mermaid
graph TD
    CLI[cli<br/>コマンド解析・終了コード] --> ORCH[orchestrator<br/>パイプラインDAG制御]
    ACTION[github-action<br/>Phase 2] --> ORCH
    ORCH --> INTENT[intent<br/>Stage 0: Claim抽出]
    ORCH --> SANDBOX[sandbox<br/>worktree/コンテナ管理]
    ORCH --> STATIC[static-checks<br/>Stage 1]
    ORCH --> DYNAMIC[dynamic-checks<br/>Stage 2]
    ORCH --> REVIEW[review<br/>Stage 3: レンズ]
    ORCH --> REFUTE[refutation<br/>Stage 4: 反証ゲート]
    ORCH --> PROBE[probe<br/>Stage 5: Driver registry]
    ORCH --> JUDGE[judge<br/>Stage 6: 決定的判定]
    INTENT --> AGENTS[agents<br/>LLM呼び出し共通層]
    REVIEW --> AGENTS
    REFUTE --> AGENTS
    DYNAMIC --> AGENTS
    DYNAMIC --> SANDBOX
    STATIC --> SANDBOX
    PROBE --> SANDBOX
    PROBE --> DRIVERS[probe-drivers/*<br/>cli api web electron tui ...]
    ORCH --> STORE[evidence-store<br/>.verifier/runs/]
    ORCH --> REPORT[reporter<br/>Markdown/JSON]
    JUDGE -.依存なし: 純関数.-> JUDGE
```

依存の原則:

- `judge`（Stage 6）は**純関数モジュール**。LLM・FS・ネットワークに依存せず、`(Claim[], Finding[], RunMeta) → Verdict` のみ。単体テストで全分岐を網羅する。
- `agents` がLLM依存を一手に引き受ける。他モジュールはLLMを直接呼ばない（プロンプト契約とリトライ・コスト計測を一元化）。
- `probe-drivers/*` は `probe-sdk` にのみ依存する独立パッケージ。SDK公開（Phase 2）を見据え、コアの内部型をimportしない。
- ドライバとコアで共有するプリミティブ型（`TargetType`、`Scenario`、`Observation` 等）は **`probe-sdk` 側で定義し、`core` が再export** する（依存方向: core → probe-sdk。逆はなし）。

### パッケージ構成（モノレポ）

```
packages/
  core/            # orchestrator, judge, intent, review, refutation, types
  agents/          # LLM共通層（Claude Agent SDK ラッパ）
  sandbox/         # worktree / コンテナ / ネットワークポリシー
  probe-sdk/       # ProbeDriver インターフェース（公開API、依存ゼロ）
  probe-drivers/   # cli, api, web, electron, tui, ...（probe-sdkのみに依存）
  evidence/        # Evidence Store
  reporter/        # Markdown / JSON / GitHubコメント
  cli/             # bin: verifier
fixtures/          # EVAL.md参照（fixtureアプリ・コーパス）
```

## 2. データモデル（TypeScript型定義）

`packages/core/src/types.ts` の正本。verdict.schema.json（§3）はここから生成する（drift防止のため手書き二重管理をしない）。

```typescript
export type TargetType =
  | 'cli' | 'api' | 'web' | 'electron' | 'tauri'
  | 'macos-native' | 'windows-native' | 'tui' | 'mobile';

export type TrustLevel = 'trusted' | 'untrusted';

export type CheckKind =
  | 'runtime'   // Stage 5 実行観測 / 再現コード実行（強度 1.0）
  | 'test'      // テスト実行（0.9）
  | 'static'    // build/typecheck/lint（0.7）
  | 'reading';  // コードリーディング（0.5）

export type ClaimPriority = 'must-verify' | 'nice-to-verify';
export type ClaimStatus = 'verified' | 'failed' | 'unverified';

export interface Claim {
  id: string;                    // "C-1"
  statement: string;             // 「空配列を渡してもクラッシュしない」
  priority: ClaimPriority;
  source: IntentSource;          // どのIntentソースに由来するか
  plannedChecks: CheckKind[];    // 空配列 = 検証手段なし → unverified確定
  status: ClaimStatus;           // Stage 6で確定
  evidenceIds: string[];
}

export interface IntentSource {
  tier: 'primary' | 'secondary'; // primary=人間由来, secondary=生成エージェント由来
  kind: 'issue' | 'user-prompt' | 'spec-file' | 'pr-description' | 'commit-message';
  ref: string;                   // issue URL、ファイルパス等
}

export type FindingCategory =
  | 'security' | 'data-loss' | 'crash' | 'regression'
  | 'logic' | 'perf' | 'style';

export type Severity = 'blocker' | 'major' | 'minor' | 'info';

export interface Finding {
  id: string;                    // "F-1"
  category: FindingCategory;     // LLMが出力
  reproduced: boolean;           // 決定的な再現Evidenceの有無
  severity: Severity;            // deriveSeverity()で導出。LLMは設定しない
  title: string;
  location?: { file: string; line?: number };
  scenario: string;              // 問題が起きる具体的シナリオ（必須・空文字禁止）
  claimIds: string[];            // このFindingがfailさせるClaim（なければ空配列）。
                                 // must-verify Claimを含み reproduced=true なら当該Claimをfailedにする
  evidenceIds: string[];
  refutation: RefutationResult;  // 反証ゲートの結果
  origin: 'stage2' | 'stage3' | 'stage5';
  lens?: 'correctness' | 'security' | 'regression' | 'performance';
}

export interface RefutationResult {
  required: boolean;             // reproduced=true なら false
  attempted: boolean;
  outcome: 'survived' | 'refuted' | 'skipped';
  notes?: string;
  evidenceIds: string[];
}

export interface Evidence {
  id: string;                    // "E-1"
  kind: 'command-output' | 'test-result' | 'screenshot' | 'network-log'
      | 'console-log' | 'perf-trace' | 'code-reading' | 'llm-judgment';
  checkKind: CheckKind;
  summary: string;
  path: string;                  // .verifier/runs/<id>/evidence/E-1.* への相対パス
  reproducible: boolean;         // 再現コマンド/手順を含むか
  command?: string;              // 再現コマンド
}

export type VerdictKind = 'mergeable' | 'conditional' | 'not_mergeable' | 'inconclusive';

export interface Verdict {
  schemaVersion: 1;
  kind: VerdictKind;
  confidence: number;            // 0–100（§4の式）
  conditions: string[];          // conditional時の解消条件
  claims: Claim[];
  findings: Finding[];           // survived のみ。refuted は report.discardedFindings へ
  discardedFindings: Finding[];  // 反証で破棄されたもの（透明性）
  evidence: Evidence[];
  run: RunMeta;
}

export interface RunMeta {
  runId: string;
  startedAt: string;             // ISO 8601
  baseRef: string;
  headRef: string;
  trustLevel: TrustLevel;
  stagesExecuted: number[];
  stagesSkipped: { stage: number; reason: string }[];
  targets: TargetType[];
  cost: { inputTokens: number; outputTokens: number; usd: number };
  durationMs: number;
}
```

### severity導出（純関数）

```typescript
export function deriveSeverity(f: Pick<Finding, 'category' | 'reproduced'>,
                               failedMustClaim: boolean): Severity {
  if (failedMustClaim) return 'blocker';
  const critical: FindingCategory[] = ['security', 'data-loss', 'crash', 'regression'];
  if (critical.includes(f.category)) return f.reproduced ? 'blocker' : 'major';
  if (f.category === 'logic' || f.category === 'perf') return f.reproduced ? 'major' : 'minor';
  return 'minor'; // style
}
```

### Verdict決定（純関数）

```typescript
export function decideVerdict(claims: Claim[], findings: Finding[],
                              envFailure: boolean): VerdictKind {
  const survived = findings.filter(f => f.refutation.outcome !== 'refuted');
  if (survived.some(f => f.severity === 'blocker')) return 'not_mergeable';
  if (claims.some(c => c.priority === 'must-verify' && c.status === 'failed'))
    return 'not_mergeable'; // deriveSeverityでblocker化されるため通常1行目で捕捉。防御的に明記
  if (envFailure) return 'inconclusive';
  const mustUnverified = claims.some(
    c => c.priority === 'must-verify' && c.status === 'unverified');
  if (survived.some(f => f.severity === 'major') || mustUnverified) return 'conditional';
  return 'mergeable';
}
```

## 3. verdict.schema.json

`packages/core/src/types.ts` から `ts-json-schema-generator` で生成し、`schemas/verdict.schema.json` としてコミットする。CIで「生成結果とコミット済みスキーマの一致」を検証する（drift検出）。ルート型は `Verdict`、`$id` は `https://github.com/s-hiraoku/verifier/schemas/verdict.schema.json`、`schemaVersion` フィールドで後方互換を管理する（破壊的変更時にインクリメント）。

## 4. 確信度算出式

```
confidence = clamp(round(100 × Σ(w_i × s_i × v_i) / Σ(w_i)) − penalty, 0, 100)

w_i: Claim重み      must-verify = 2, nice-to-verify = 1
s_i: Check強度      実際に使われたCheckの最大強度
                    runtime = 1.0, test = 0.9, static = 0.7, reading = 0.5
v_i: 検証結果       verified = 1, failed / unverified = 0
penalty: survived Findingによる減点
                    major = 8/件, minor = 2/件, info = 0（blockerは確信度に関係なくnot_mergeable）
```

- 例（SPEC §6の出力例と同期）: must 3件 verified（C1: test=0.9、C2: テストパスを含むため test=0.9、C3: runtime=1.0）+ nice 1件 unverified
  = 100 × (2×0.9 + 2×0.9 + 2×1.0) / 7 = 80 − (major 8 + minor 2) = **70**
- 式の定数は `judge/constants.ts` で一元管理し、変更はEvalコーパスの全再実行を伴う（EVAL.md §5）。

## 5. パイプライン制御（Orchestrator）

### 実行DAG

```mermaid
flowchart LR
    S0[Stage 0<br/>Intent分解] --> S1[Stage 1<br/>静的検証]
    S1 -->|fail=blocker| S6[Stage 6<br/>判定統合]
    S1 -->|pass| S2[Stage 2<br/>動的検証]
    S1 -->|pass| S3[Stage 3<br/>多視点レビュー]
    S2 --> G4{反証ゲート<br/>Stage 4}
    S3 --> G4
    S1 -->|pass| S5[Stage 5<br/>実行時観測]
    S5 --> G5{反証ゲート<br/>Stage 5由来}
    G4 --> S6
    G5 --> S6
```

- Stage 2 / 3 / 5 は**並列実行**（同一worktreeを読むが、実行系はStage間でポートとtmpを分離）。
- 反証ゲートは `refutation` モジュールの同一実装を2箇所から呼ぶ（`reproduced=true` のFindingはスキップ）。
- Stage 1失敗時はStage 2/3/5をスキップし、`stagesSkipped` に理由を記録して即Stage 6へ。

### シーケンス（`verifier check --base main`）

```mermaid
sequenceDiagram
    participant U as user
    participant C as cli
    participant O as orchestrator
    participant SB as sandbox
    participant A as agents(LLM)
    participant P as probe
    participant J as judge
    U->>C: verifier check --base main
    C->>O: RunConfig
    O->>SB: prepare(base, head)  # worktree×2（差分観測用）
    O->>A: Stage0: Intent抽出（一次ソース優先）
    A-->>O: Claim[]（priority付き）
    O->>SB: Stage1: build/typecheck/lint
    alt Stage1失敗
        O->>J: judge(claims, blockerFinding)
    else 成功
        par Stage2 / Stage3 / Stage5
            O->>SB: 既存テスト + 生成テスト実行
            O->>A: 4レンズ並列レビュー
            O->>P: detect → launch → interact → observe → teardown
        end
        O->>A: 反証ゲート（reproduced=falseのFindingのみ）
        O->>J: judge(claims, survivedFindings)
    end
    J-->>O: Verdict
    O->>C: Verdict + レポートパス
    C-->>U: Markdown表示 / exit code
```

### 状態と再開

- 各Stageの完了時に `.verifier/runs/<id>/state.json` にチェックポイントを書く。`--resume <run-id>` で未完了Stageから再開（LLMコスト節約）。
- `--reuse-claims <run-id>` は state.json からStage 0の出力のみ読み込む。

## 6. Probe Driver SDK

`packages/probe-sdk`（依存ゼロの公開パッケージ）。

```typescript
export interface ProbeDriver {
  readonly targetType: TargetType;
  /** プロジェクトを検査して対応可否を返す。nullなら非対応 */
  detect(ctx: ProjectContext): Promise<DetectResult | null>;
  /** ターゲットを起動しセッションを返す。起動失敗はLaunchErrorをthrow */
  launch(ctx: LaunchContext): Promise<ProbeSession>;
}

export interface ProjectContext {
  rootDir: string;
  packageJson?: Record<string, unknown>;
  files: (glob: string) => Promise<string[]>;
  config?: ProbeConfig;          // verifier.config の probe セクション
}

export interface DetectResult {
  confidence: number;            // 0–1。複数ドライバが反応した場合は高い方
  launchHint: string;            // 起動方法の説明（例: "npm run dev → :5173"）
}

export interface LaunchContext {
  workdir: string;               // base or head のworktree
  env: Record<string, string>;
  ports: PortAllocator;          // 並列実行時の衝突回避
  timeoutMs: number;             // §SPEC 9 の時間予算から配分
  networkPolicy: NetworkPolicy;  // 許可リスト
}

export interface ProbeSession {
  /** シナリオを実行。各stepの成否を返す */
  interact(scenario: Scenario): Promise<StepResult[]>;
  /** 現時点の観測を収集（interactと独立に何度でも呼べる） */
  observe(): Promise<Observation>;
  teardown(): Promise<void>;
}

export interface Scenario {
  id: string;
  description: string;           // 対応するClaim/フローの説明
  claimIds: string[];            // このシナリオが検証するClaim
  steps: Step[];
}

/** ドライバ非依存の操作プリミティブ。非対応stepはUnsupportedStepErrorをthrowし、
    orchestratorはVision LLMフォールバック（screenshot + 自然言語指示）に切り替える */
export type Step =
  | { op: 'navigate'; url: string }
  | { op: 'click'; target: string }          // セレクタ/AXロール/座標はドライバが解釈
  | { op: 'type'; target: string; text: string }
  | { op: 'key'; keys: string }
  | { op: 'exec'; command: string; stdin?: string }
  | { op: 'request'; method: string; path: string; body?: unknown; headers?: Record<string,string> }
  | { op: 'wait'; forMs?: number; until?: string }
  | { op: 'assert-screen'; naturalLanguage: string };  // Vision LLM判定（反証必須Finding源）

export interface Observation {
  consoleErrors: LogEntry[];     // 新規/既存の区別はorchestrator側で差分化
  networkFailures: NetworkEntry[];
  screenshots: Artifact[];
  perf?: PerfMetrics;            // LCP/INP等。web系のみ
  exitCode?: number;             // cli/tui
  stdout?: string;
  stderr?: string;
  crashed: boolean;
  artifacts: Artifact[];         // HAR、トレース等
}

// ---- 補助型（すべてprobe-sdkで定義） ----
export interface StepResult { stepIndex: number; ok: boolean; error?: string; artifacts: Artifact[] }
export interface Artifact { kind: 'screenshot' | 'har' | 'trace' | 'log' | 'file'; path: string }
export interface LogEntry { level: 'error' | 'warn'; text: string; source?: string; timestamp: string }
export interface NetworkEntry { method: string; url: string; status?: number; failed: boolean }
export interface PerfMetrics { lcpMs?: number; inpMs?: number; raw?: Artifact }
export interface PortAllocator { acquire(): Promise<number>; release(port: number): void }
export interface NetworkPolicy { allowedHosts: string[] }
export interface ProbeConfig {
  launch?: string; readyWhen?: string; port?: number; scenarios?: Scenario[];
}
```

実装規約:

- ドライバは**Findingを作らない**。観測（Observation）を返すだけで、Finding化と差分判定はorchestrator/judge側の責務（ドライバ実装者にルーブリックの知識を要求しない）。
- `detect` は副作用禁止（ファイル読み取りのみ）。
- ドライバ登録: 同梱は `probe-drivers/` から静的登録。サードパーティは `verifier.config` の `probe.drivers: ["@scope/verifier-driver-x"]` でnpmパッケージ名指定。

## 7. CLI仕様

```
verifier check [path]            # デフォルト: 作業ツリーの未コミット変更
  --base <ref>                   # 比較先（default: マージベース）
  --pr <number>                  # GitHub PR（gh CLI経由で取得）
  --intent <ref>                 # issue#45 | ファイルパス | 文字列（複数指定可・一次ソース扱い）
  --stages <list>                # 実行Stage（default: 0,1,2,3,4,5,6）
                                 # 4（反証ゲート）を除外した場合、反証必須のFinding
                                 # （reproduced=false）はseverity導出をスキップし
                                 # info に降格して判定に影響させない
  --json                         # VerdictのJSONをstdoutへ（人間向け出力はstderrへ）
  --reuse-claims <run-id>        # Claimセット固定再実行
  --resume <run-id>              # チェックポイントから再開
  --trust <trusted|untrusted>    # default: trusted。untrusted+コンテナ未整備なら実行系skip
  --budget-minutes <n>           # 全体時間予算（default: 30）
  --fail-on <verdict>            # exit code 1 にする閾値（default: not_mergeable）

verifier report <run-id>         # 過去runのレポート再表示
verifier runs                    # run一覧
```

終了コード: `0` = `--fail-on` 閾値未満 / `1` = 閾値以上（not_mergeable等） / `2` = inconclusive / `64` = 設定・引数エラー / `70` = 内部エラー。

### verifier.config.{json,ts} スキーマ（主要キー）

```typescript
export interface VerifierConfig {
  commands?: { build?: string; test?: string; lint?: string; typecheck?: string };
  trust?: TrustLevel;
  confidence?: { failOn?: VerdictKind };
  probe?: {
    targets?: Partial<Record<TargetType, { launch: string; readyWhen?: string; port?: number }>>;
    scenarios?: Scenario[];      // 明示シナリオ（自動生成に追加）
    drivers?: string[];          // サードパーティドライバ
    enabled?: boolean;           // default: true
  };
  network?: { allow?: string[] };  // 許可リスト追記（レジストリ/localhost/LLM APIは常時許可）
  llm?: { model?: string; maxBudgetUsd?: number };
}
```

## 8. Evidence Store レイアウト

```
.verifier/
  runs/
    2026-06-12T0930-a1b2c3/
      state.json          # チェックポイント（Stage単位）
      verdict.json        # Verdict（schema準拠）
      report.md           # 人間向けレポート
      claims.json         # Stage 0出力（--reuse-claims対象）
      evidence/
        E-1.txt           # コマンド出力
        E-2.png           # スクリーンショット
        E-3.har           # ネットワーク記録
      meta.json           # RunMeta
  cache/                  # ベース環境のビルドキャッシュ
```

`.verifier/` はデフォルトで `.gitignore` 追記を提案する（初回実行時）。

## 9. agents層（LLMプロンプト契約）

すべてのLLM呼び出しは構造化出力（JSON Schema強制）で行い、自由文の解析をしない。

| エージェント | 入力 | 出力スキーマ（要点） |
|---|---|---|
| intent-extractor | Intentソース（tier付き）+ diff要約 | `{ claims: {statement, priority, plannedChecks, sourceRef}[], conflicts: string[] }` |
| lens-reviewer ×4 | diff + 周辺コード + レンズ定義 | `{ findings: {category, title, location, scenario, suggestedRepro?}[] }` ※severityフィールドは存在しない |
| test-generator | 変更関数のシグネチャ + 既存テスト例 | `{ tests: {name, code, targetClaim?}[] }` |
| refuter | Finding + 関連コード + 実行権限 | `{ outcome: 'survived'\|'refuted', reasoning, reproCommand? }` |
| scenario-generator | diff + 検出ターゲット + Claim | `{ scenarios: Scenario[] }` |
| vision-judge | スクリーンショット + 自然言語アサーション | `{ pass: boolean, observation: string }` |

共通規約: temperature等の生成パラメータ・モデルIDは `agents/config.ts` で固定しrunMetaに記録（再現性）。リトライはスキーマ不一致時のみ最大2回。トークン・コストを呼び出し単位で計測し `RunMeta.cost` に集計。

## 10. エラーハンドリング方針

| 事象 | 扱い |
|---|---|
| Stage実行不能（環境構築失敗、コマンド不在） | Stageを`skipped`にし理由を記録。must-verify Claimの検証手段が全滅した場合のみ`inconclusive` |
| Probe起動失敗 | そのターゲットを「未観測」とし、対応Claimは`unverified`へ。リトライ1回 |
| シナリオ時間予算超過 | シナリオ中断 → `unverified`。Findingにしない（flaky源を判定に入れない） |
| LLMスキーマ不一致（リトライ後も） | そのエージェントの出力を空として続行し、infoのFindingで明示 |
| LLM API障害 | チェックポイントを書いてexit 70。`--resume`で再開可能 |
| 予算超過（--budget-minutes / maxBudgetUsd） | 残Stageをskipped化して即Stage 6（部分結果で判定、確信度に反映） |
