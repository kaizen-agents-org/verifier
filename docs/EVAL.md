# Verifier Evalハーネス仕様 (v0.1)

[SPEC.md §11](./SPEC.md) の「Verifier自身の検証」を実装に落とす文書。型は [DESIGN.md](./DESIGN.md) のものを使う。

## MVP implementation

The repository now includes an executable MVP harness for the deterministic
verdict contract:

```sh
pnpm eval
```

The initial committed corpus lives under `packages/core/eval/corpus/seeded` and
`packages/core/eval/corpus/golden`. Cases are JSON for the MVP so the harness can
run without adding a YAML parser dependency. Each case records verifier input,
expected verdict constraints, and false-positive allowances. The command emits
JSON metrics, including `verdictAgreement` and `falsePositiveRate`, and exits
non-zero when any case fails.

The MVP corpus includes seeded/golden cases for `open_pr`,
`open_pr_with_warning`, `block_pr`, and `needs_context` so readiness reviews can
cite all currently shipped verdict outcomes from one reproducible command.

The remainder of this document describes the broader staged verifier eval design.

## 1. ディレクトリ構成

```
fixtures/
  corpus/                      # ベンチマークコーパス（§2）
    seeded/
      sb-001-auth-bypass/
        case.yaml              # ケース定義（§2.1）
        repo/                  # ベースとなる正常なミニプロジェクト
        bug.patch              # 注入するバグ
      sb-002-off-by-one/
      ...
    golden/
      gp-001/
        case.yaml              # 外部リポジトリ参照（repo URL + base/head SHA）
  apps/                        # ドライバ検証用fixtureアプリ（§3）
    web-spa/
    electron-min/
    cli-tool/
    tui-min/
    api-server/
eval/
  run.ts                       # コーパス全実行 → metrics.json
  metrics.ts                   # §4の指標算出
  thresholds.json              # リリースゲート閾値
```

## 2. ベンチマークコーパス

### 2.1 case.yaml スキーマ

```yaml
id: sb-001-auth-bypass
kind: seeded            # seeded | golden
description: 管理APIの認可チェックがPOSTに適用されない
intent:                 # Verifierに渡すIntent（一次ソースとして扱う）
  text: "管理APIに認可チェックを追加する"
expected:
  verdict: not_mergeable  # 単一値。幅を許す場合は verdictAnyOf を使う
                          # 区分の順序は mergeable < conditional < not_mergeable
                          # （inconclusiveは順序外。DESIGN.md VerdictKind参照）
  verdictAnyOf: [conditional, not_mergeable]  # 任意。VerdictKind[]。verdictの代替。
                          # 指定時は列挙した区分のいずれかに一致すれば期待判定とみなす。
                          # verdict と同時指定しない（混在結果ケースは verdictAnyOf を使う）
  confidenceMax: 95       # 任意。確信度の上限期待（「確信度が下がること」の検証用）
  findings:               # 期待Finding（検出率の分母）
    - category: security
      locationFile: src/routes/admin.ts
      locationLine: 42    # 任意。指定時は±10行でマッチ判定（§4）
      mustDetect: true    # falseなら「検出できれば加点」扱い
  maxFalsePositives: 1    # 許容する余剰Finding数（これ超過で偽陽性カウント。§4の式参照）
setup:                  # seededのみ
  baseDir: repo/
  patch: bug.patch
golden:                 # goldenのみ
  repoUrl: https://github.com/...
  baseSha: abc123
  headSha: def456
  labelSource: "revert PR #99 に理由記載"   # ラベル根拠（必須）
timeoutMinutes: 15
```

### 2.2 1ケースの実行手順（eval/run.ts）

seededケースは `repo/` がgitリポジトリではないため、ハーネスが毎回構成する:

```
1. tmpdirへ repo/ をコピーし git init → 全ファイルcommit（= baseSha）
2. bug.patch を適用して commit（= headSha）。kind=golden の場合は repoUrl をclone
   して baseSha/headSha をチェックアウトするだけ
   ※コミットメッセージは中立固定値（"base" / "apply changes"）とする。
     ハーネスがIntent情報をコミットメッセージ（二次ソース）経由で漏らさないため
3. verifier check --base <baseSha> --json --budget-minutes <timeoutMinutes> を実行。
   case.yaml に intent があれば --intent "<intent.text>" を付与（一次ソース扱い）。
   sb-009 のような意図欠如ケースでは --intent を渡さない
4. stdout の Verdict JSON（verdict.schema.json 準拠）をパースし、expected と照合
5. exit code 70（内部エラー）はケース失敗ではなくハーネスエラーとして別カウント
```

### 2.2.1 Phase 1 初期コーパス（seeded 10件）

すべてTypeScript/Nodeの自己完結ミニプロジェクト（外部サービス依存なし）。SPEC §5のレンズとルーブリックの主要分岐を1件以上ずつ踏む。

| id | 注入バグ | category | 期待verdict | 検証している分岐 |
|---|---|---|---|---|
| sb-001 | POSTルートの認可チェック欠落 | security | not_mergeable | 再現可能security → blocker |
| sb-002 | ページネーションのoff-by-one | logic | conditional | 再現logic → major |
| sb-003 | 既存テストが落ちる回帰 | regression | not_mergeable | Stage 2の既存テスト差分 |
| sb-004 | 空配列入力でTypeError | crash | not_mergeable | エッジケース再現（※1） |
| sb-005 | エラーパスでファイルハンドルリーク | logic | conditional | 読解のみ→反証で再現させmajor化（reproConfirmed昇格） |
| sb-006 | 環境変数のAPIキーをログ出力 | security | not_mergeable | secret scan + security レンズ |
| sb-007 | キャッシュキー衝突（マルチバイト） | logic | conditional | エッジケース再現（※1） |
| sb-008 | **バグなし**（正しいリファクタ） | — | mergeable | 偽陽性ゼロの確認 |
| sb-009 | **バグなし** + 説明のないdiff | — | conditional + confidenceMax: 50 | 合成Claim C-0（must・unverified）による`conditional`化と確信度低下 |
| sb-010 | issueは機能Aを要求、実装はB | — | verdictAnyOf: [conditional, not_mergeable] | 一次/二次ソースの食い違い → 一次ソース由来must Claimのunverified/failed |

※1: テスト生成はPhase 2機能のため、Phase 1では**反証エージェントの再現コード実行**（Stage 4）で検出する経路を正とする。Phase 2でテスト生成導入後も同じ期待値で通ること（検出経路が増えるだけ）を確認する。

sb-008/009のような**正常ケースを必ず含める**（検出率だけ最適化して偽陽性が壊れるのを防ぐ）。

## 3. ドライバ検証用fixtureアプリ

各アプリは環境変数 `FIXTURE_DEFECTS`（カンマ区切り）で欠陥をON/OFFできる。**同一アプリが正常系と欠陥系の両方を担う**（ドライバが「欠陥を検出できる」と「正常系で偽検出しない」を同じコードで検証）。

### 3.1 web-spa（Vite + 最小SPA、3画面）— Phase 2（webドライバと同時）

| defect key | 内容 | 期待されるObservation |
|---|---|---|
| console-error | マウント時に`console.error` | consoleErrors に新規1件 |
| broken-fetch | 一覧画面のAPIが404 | networkFailures に1件 |
| slow-lcp | 画像にsleepを注入しLCP>4s | perf.lcp 劣化 |
| layout-break | CSS破壊でボタンが画面外 | assert-screen "送信ボタンが見える" がfail |

### 3.2 cli-tool（ファイル変換CLI）

| defect key | 内容 | 期待 |
|---|---|---|
| bad-exit | 正常時に exit 1 | exitCode ≠ 0 |
| stderr-noise | 成功時にstderrへ出力 | stderr 非空 |
| missing-output | 出力ファイルを書かない | 副作用検証fail |
| hang | 特定入力で無限ループ | timeoutで中断 → crashed=false, 時間超過記録 |

### 3.3 api-server（Express 3エンドポイント）

| defect key | 内容 | 期待 |
|---|---|---|
| authz-gap | POSTのみ認可スキップ | request stepで200（期待401） |
| schema-drift | レスポンスからフィールド欠落 | スキーマ差分 |
| flaky-500 | `?fail=1` または `X-FLAKY: true` 指定時だけ500を返す（未指定時は200） | リトライポリシーの検証。例: `GET /health?fail=1` を1回目に実行し、retry後は `GET /health` で成功させる |

### 3.4 electron-min / tui-min（Phase 2）

electron-min: `renderer-crash`（レンダラprocess crash）、`ipc-error`（IPC reject）、`blank-window`（白画面 → assert-screen fail）。
tui-min: `key-ignored`（qで終了しない）、`render-garbage`（画面バッファ崩れ）、`hang`。

### 3.5 ドライバCIテストの形

```typescript
// 各ドライバに対して同一のパラメタライズドテスト
for (const defect of fixture.defects) {
  test(`${driver.targetType} detects ${defect.key}`, async () => {
    const obs = await runProbe(driver, fixture, { defects: [defect.key] });
    expect(matchesExpectation(obs, defect.expected)).toBe(true);
  });
}
test(`${driver.targetType} clean run has no failures`, async () => {
  const obs = await runProbe(driver, fixture, { defects: [] });
  expect(obs.consoleErrors).toHaveLength(0);  // 等
});
```

## 4. メトリクス定義

`eval/run.ts` がコーパス全件にVerifierを実行し、`metrics.json` を出力する。

| 指標 | 定義 |
|---|---|
| **recall** | mustDetect=true の期待Findingのうち、survived Findingとマッチしたものの割合。**マッチ条件**: `locationFile` 一致 かつ category一致。期待側に `locationLine` があれば実Findingの行と±10行以内であること。実Findingの `location` が欠落している場合はマッチ不成立 |
| **fpRate** | `Σ_case max(0, 未マッチsurvived数 − maxFalsePositives) / Σ_case survived総数`。SPEC §12 KPIの偽陽性率（人間判断ベース）の自動推定値として使う |
| **verdictAgreement** | 判定が期待と一致したケースの割合。一致条件: `expected.verdict` と一致、または `expected.verdictAnyOf` 指定時はそのいずれかと一致し、かつ `confidenceMax` 指定時は confidence ≤ confidenceMax |
| **reproducibility** | 全ケースをN=5回実行し、Verdict区分が5回とも一致したケースの割合（リリースタグ時のみ算出。§5） |
| **costPerRun** | 1ケースあたり平均USD / 平均トークン |
| **wallClock** | 1ケースあたり平均実行時間 |

## 5. リリースゲート

`eval/thresholds.json`（初期値。実測に応じてPRで改訂し、緩める変更には理由を必須化）:

```json
{
  "recall": 0.85,
  "fpRate": 0.10,
  "verdictAgreement": 0.90,
  "reproducibility": 0.95
}
```

- **実行タイミング**: (a) リリースタグ作成時に全件×N=5（reproducibilityを算出）、(b) `judge`/`agents`/プロンプト/確信度定数の変更PRで全件×N=1（reproducibilityはN/A）、(c) 通常PRはsmoke subset（sb-001/003/008）×N=1。
- 閾値未達のリリースはCIがブロックする。
- 確信度定数（DESIGN §4）やプロンプトの変更は、変更前後のmetrics.json差分をPRに自動コメントする。

## 6. キャリブレーションループ（Phase 3）

- 運用中のVerdictと人間の最終判断（マージ/クローズ/修正後マージ）をGitHub APIで突合し、不一致ケースを `fixtures/corpus/golden/` 候補として記録する。
- 候補は人間がラベル根拠（labelSource）を付けてコーパス入りさせる（自動では入れない — ラベルノイズ対策、SPEC §11.1）。
