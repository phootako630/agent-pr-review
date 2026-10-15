# Bounded source verifier

This optional evaluation stage checks saved candidate findings. It does not discover new issues, write code, post comments, approve rework or change the normal worker. The first development experiment is recorded in [VERIFIER-PILOT.md](VERIFIER-PILOT.md).

## Protocol

`bounded-source-v2` starts a fresh, tool-free, browser-authenticated CLI session with the original immutable snapshot and candidate IDs. Source entries include original line numbers. No reference labels, adjudication, prior verifier responses from other cases, or follow-up fixes enter the prompt. Existing adapters accept an explicitly supplied structured-output schema; ordinary reviews retain their original schema, isolated credential homes, tool restrictions and API/browser routing behavior.

The initial response either decides every original candidate or requests source with an empty decision list. A request includes repository-relative path, LEFT/RIGHT side, start/end lines, and a reason. The host permits at most **one round, four requests, 200 lines per request, and 32,000 added UTF-8 bytes**. It reads no more than 1,000,000 bytes per source file. Inference packets, including numbered source and instructions, must also fit the configured `maxContextBytes` ceiling.

For public cases, LEFT resolves to `mergeBaseSha` and RIGHT to `headSha`. A LEFT request using a renamed file's destination path resolves through the snapshot's `previousPath`; citations accept either that logical destination or the original path. The reader fetches text from `raw.githubusercontent.com` at the exact commit and path, falling back to ReviewBench's `<owner>_<repo>` mirror at the same commit if the original object is unavailable. It sends no provider/GitHub credentials, accepts no arbitrary host, rejects unsafe paths and redirects, and never checks out or executes code. Mirror availability is not assumed for arbitrary non-ReviewBench datasets. Synthetic requests can read only files already in the immutable packet, never the caller's filesystem or labels. Source records include revision, request, text, content hash and availability; an unavailable read remains explicit.

The final turn must decide every original candidate and request no further source. Decisions are:

- `supported`: source evidence and a concrete trigger substantiate the candidate.
- `rejected`: counterevidence refutes it.
- `uncertain`: the available evidence is insufficient.

Supported/rejected decisions require exact single-line source quotations at supplied path/side/line coordinates. A missing or invalid citation downgrades the effective decision to uncertain; the original model response is preserved. The host does not silently move an anchor to a nearby line. This is a provenance check, not a semantic proof: a valid quote can still accompany a wrong inference, so model verdicts remain reviewable opinions.

Uncertain candidates remain available for human inspection. They are not auto-rejected. No verification verdict updates production publication eligibility or author/human approval state.

## Run against a completed baseline

Use the pinned CLI setup in [WORKER.md](WORKER.md) and the original dataset/run from [EVALUATION.md](EVALUATION.md). Select exactly one verifier with explicit browser authentication.

```sh
npm run build
npm run eval -- verify .pr-review/eval/pilot-v1-windowed/manifest.json \
  --run .pr-review/eval/runs/codex-rubric-dev-v1/run.json \
  --config examples/eval.codex.browser.json --max-calls 12 \
  --output .pr-review/eval/verification/codex-source-dev-v2
```

On PowerShell, use a single line or PowerShell continuation syntax. The budget reserves the worst case: two invocations for each case with candidates; cases without candidates require none. A 12-case baseline containing candidates in six cases therefore needs a budget of twelve, even if every case decides in one turn. Invocation counts include failures; exact provider token consumption and billed cost are not enforced by this count.

Each invocation has `providerTimeoutSeconds`, and the whole case including source reads has `timeoutSeconds`. Auth, quota, protocol failure, timeout or cancellation preserves every candidate in that case as uncertain and stops further cases. Successful original baseline results are not rerun. The CLI reports controlled diagnostics without saving private exception output.

`--resume` reuses validated completed verification cases only when the baseline, dataset, configuration, prompt policy and source hashes agree. An interrupted started call requires inspecting its cause and choosing a new output for an explicit rerun. A previous failure cannot silently advance to additional cases. Lock files contain PID/time. Partial/corrupt results fail validation; hashes establish consistency, not signed proof of a model call.

Artifacts are private local `experiment.json`, per-case `result.json`, and `verification.json`. They contain original and effective decisions, source records, CLI/model metadata, prompt hashes, durations and native usage. Actual billed cost remains null. Temporary provider homes are removed by existing adapters. No persistent background evaluator is started.

## Compare after adjudication

Keep the original pending worksheet and write agent-assisted or human judgements to a separate file. Use `human` only for actual human adjudication.

```sh
npm run eval -- compare-verification .pr-review/eval/pilot-v1-windowed/manifest.json \
  --run .pr-review/eval/runs/codex-rubric-dev-v1/run.json \
  --verification .pr-review/eval/verification/codex-source-dev-v2/verification.json \
  --judgements .pr-review/eval/adjudication/codex-rubric-dev-v1/judgements.agent-assisted.json
```

The comparison reports supported/rejected/uncertain counts, known true findings rejected, false findings rejected, true findings retained or left uncertain, incomplete annotations, original calls and additional invocations. It validates that all verdicts belong to the same baseline candidates and recomputes citation qualification before using them. A test deliberately makes the verifier reject a supported bug and confirms that the report counts this as harm.

This verifier cannot recover baseline misses. Extra verification calls do not constitute a budget-matched comparison against the original baseline. A meaningful next study needs false-positive challenges, independent adjudication, and a matched-budget alternative (such as extra independent review) before selecting a default. Development runs may guide protocol changes; the reserved test set stays unused until the strategy is frozen.
