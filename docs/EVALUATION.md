# M4.5: local review evaluation

The experiment asks whether an evidence rubric, a verifier, or multiple providers improves useful defect discovery at a comparable allowance budget. M4's 67 tests established orchestration behavior; they did not establish review quality. This slice supplies fixed data, a baseline runner, and adjudication tools. A verifier and strategy comparison are subsequent experiments, not implemented or demonstrated by this PR.

## Dataset and split

`eval/reviewbench-selection.json` pins ten public tasks from MIT-licensed ReviewBench at `5bba258937cc7d43577ce9a81a389a6550a20fa9`, including pre-review base/head commits. `eval/synthetic.json` supplies ten original coordinator fixtures (seven defect cases and three correct changes). These fixtures model our domain; they are not ten historical production PRs. See [dataset research](EVAL-DATASETS.md) for sources and policy differences.

The prepared dataset contains **20 cases: 12 dev and 8 reserved test**. Public 01–06 and local 01–06 are dev; the remaining cases are test. Public repositories are distinct; related synthetic cases must share a group and split. Do not use any evaluation case as a few-shot. Use dev to develop a strategy, then freeze prompts, adapters, context, and budgets before a test run. Do not tune against test results. Public-case pretraining contamination is unknown, and authoring the synthetic data is not an independent blind audit.

The pilot favors manageable changes, TypeScript/JavaScript/Python, and our coordinator concerns. It does not represent all PRs or provide an official ReviewBench leaderboard score. Twenty cases are a diagnostic pilot, not sufficient evidence of universal superiority.

## Prepare and validate (no inference)

Build first, and authenticate `gh` for read access to public GitHub metadata. Preparation downloads JSON, source blobs and license notices, uses the fixed mirror comparison, and constructs local diffs with Git. It performs no checkout, dependency installation, PR script/test execution or GitHub writes.

```sh
npm ci --ignore-scripts
npm run build
npm run eval:prepare
npm run eval -- validate .pr-review/eval/pilot-v1-windowed/manifest.json
```

Inputs and answers are stored separately under ignored `.pr-review/eval/pilot-v1-windowed/{inputs,labels}`. Upstream golden files stay in `upstream/`; copyright notices stay in `notices/`. No third-party source or answer text is checked into this repository. The tracked `eval/pilot-v1-windowed.lock.json` records the prepared manifest, including content hashes. Preparation checks this lock when present; a source mismatch fails instead of silently replacing the frozen data. To deliberately change the dataset, create a new dataset/version and review its manifest changes.

Public input is **the fixed diff plus 20 lines around each hunk**, without related files or executable tests. Blank lines outside those windows stand for unavailable source and preserve original line numbers; they do not assert that the source was empty. Exclusions disclose this limitation. Original manifest titles are retained; mutable PR bodies, review comments, expected findings, and follow-up fixes are omitted. File-count discrepancies between upstream task metadata and historical comparisons are recorded, with the immutable comparison authoritative. A full-file preliminary call used about 115k input/cache tokens, motivating this explicitly versioned context reduction before the windowed baseline.

Reference labels retain `tp` findings in correctness/reliability/security/performance that upstream marked introduced or exacerbated by the PR. Style/maintainability, other categories, pre-existing issues, and upstream false positives remain in the local original golden file, outside the scored known-issue slice. This filter is fixed, not chosen from model performance. Zero retained labels does **not** mean a public PR is clean. A reference label may still fail our rubric and needs adjudication; mark it `not_assessable` with the reason rather than automatically scoring it as a miss. Synthetic `exhaustive-fixture` labels apply only to their small stated contract, not to arbitrary production use.

## Browser-CLI baseline

Install the pinned native CLIs as described in [WORKER.md](WORKER.md). The eval launcher prepends those paths without modifying global installations. All selected reviewers must explicitly use browser auth. No API fallback or hosted judge is used. Provider/account allowance and extra-usage settings still apply; a model's estimated dollar telemetry is not an invoice.

```sh
npm run eval -- run .pr-review/eval/pilot-v1-windowed/manifest.json \
  --config examples/eval.codex.browser.json --split dev \
  --prompt rubric --limit 12 --max-calls 12 \
  --output .pr-review/eval/runs/codex-rubric-dev-v1
```

On PowerShell, put the command on one line or use PowerShell continuation syntax. Start with `--limit 1 --max-calls 1` when trying a new provider. `--prompt current` uses the existing production prompt; `rubric` adds `evidence-v1`. These modes do not alter normal reviews, workers, or publication policy. Evaluation artifacts have a separate schema and cannot be passed to `publish`. No comments are posted.

`--max-calls` bounds new adapter invocations, not exact token consumption or undocumented internal CLI behavior. A context-byte ceiling must also be supplied in config. The run refuses configuration that would alter an already frozen snapshot. Cases run sequentially; reviewers within a case use configured concurrency. The first provider/auth/quota/protocol failure stops the batch; completed peers remain visible. Any partial/incomplete coverage is recorded, never treated as a clean review.

Use `--resume` with the exact same manifest, config, split, prompt, limit and output to reuse saved cases. It does not retry a failed or interrupted model call. An interrupted `started.json` or provider failure requires checking the cause and selecting a new output directory for an explicit rerun; allowance exhaustion is not grounds for automatic retries. Stale lock files include PID/time and require inspection before manual removal. There is no background evaluator.

## Adjudicate after inference

```sh
npm run eval -- worksheet .pr-review/eval/pilot-v1-windowed/manifest.json \
  --run .pr-review/eval/runs/codex-rubric-dev-v1/run.json \
  --output .pr-review/eval/adjudication/codex-rubric-dev-v1

# Inspect worksheet.json, then edit judgements.json with evidence-backed decisions.
npm run eval -- score .pr-review/eval/pilot-v1-windowed/manifest.json \
  --run .pr-review/eval/runs/codex-rubric-dev-v1/run.json \
  --judgements .pr-review/eval/adjudication/codex-rubric-dev-v1/judgements.json
```

The worksheet opens labels only **after** candidate generation, and shows candidates next to references. Record every candidate as `true_positive`, `false_positive`, `duplicate`, `uncertain` or `unjudged`, with a rationale. A supported new finding may have no reference match. A duplicate must point to a supported candidate in that case. Independently mark every reference issue `found`, `missed`, `not_assessable` or `unjudged`; found/matched links must agree. Failed reviews cannot become ordinary misses. Answer hashes bind annotations to the dataset; run hashes bind them to the exact output. These are integrity checks, not signatures or human authentication.

Set `evaluator` to `human` only for actual human adjudication, or `agent-assisted` when an agent performs it. No LLM judge is silently run. A saved reference answer is not itself proof, and model agreement is not proof. Pending annotation, incomplete batches, and zero denominators produce null metrics rather than a fabricated percentage. Uncertain candidates suppress point precision. Non-assessable references suppress overall known-issue recall; conditional `assessableKnownIssueRecall` and all raw counts remain visible.

Metrics apply to source-valid candidate findings, **not published comments**: exact duplicate outputs across providers are grouped, semantic duplicates require adjudication, and production M3 publication may hold additional candidates. Report actionable candidate precision, known-issue recall (not exhaustive bug recall), duplicate counts/rate, invalid-anchor rejection counts, coverage, durations, provider failures, and native usage telemetry separately. Actual billed cost stays unknown. Do not compare a one-call baseline with a four-call pipeline as if budgets matched.

## Next experiments

1. Adjudicate development baseline; inspect false positives, misses, and unavailable context.
2. Freeze a bounded verifier that receives candidates and source, but never reference answers. Give it a way to request additional immutable source before drawing conclusions. Measure true findings it rejects as well as false findings it removes.
3. Compare rubric-only, rubric plus verifier, and cross-provider plus verifier under predeclared comparable budgets. Repeat runs where affordable and show variability.
4. Use reserved test cases once the strategy is frozen. Keep human decisions and rework execution separate (M5).
