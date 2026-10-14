# First evaluation pilot — 2026-10-14

This is execution evidence for the [evaluation workflow](EVALUATION.md), not a quality leaderboard or a strategy recommendation.

## Frozen inputs

- Source: ReviewBench `5bba258937cc7d43577ce9a81a389a6550a20fa9`, ten public tasks with historical base/head SHAs.
- Ten original coordinator fixtures: seven seeded defect cases, three correct changes. Unit checks execute these authored fixtures to confirm their examples; downloaded code is never executed.
- `pilot-v1-windowed`: 12 dev, 8 reserved test. Diff plus 20 surrounding lines for public source. Manifest and input/answer hashes are in `eval/pilot-v1-windowed.lock.json`.
- Two independent downloads/preparations produced identical manifest hashes. Both validated all 20 input/label identities and split groups. No test-split model calls were made.
- Public 07 metadata listed seven changed files while historical Git contained six; public 08 listed five while Git contained three. Both discrepancies are explicit exclusions in the fixed packets.

## Browser baseline

Codex CLI `0.162.1`, requested model `gpt-6.1-sol` (actual model not exposed), explicit browser authentication, rubric `evidence-v1`, maximum 12 adapter calls, 160,000 context bytes per case, 120 seconds per provider. Twelve dev cases returned structured results, zero provider failures, in **117,963 ms** of summed case time. All reports are partial because of explicit source/verification limitations.

| Case | Source | Source-valid candidates | Known reference issues |
|---|---|---:|---:|
| public-01 | bitmovin/bitmovin-player-ui #848 | 1 | 4 |
| public-02 | capawesome-team/cli #127 | 0 | 2 |
| public-03 | playcanvas/editor #1955 | 0 | 1 |
| public-04 | pnp/cli-microsoft365 #7191 | 0 | 0 |
| public-05 | namehash/ensnode #1938 | 0 | 0 |
| public-06 | axios/axios #10836 | 0 | 0 |
| local-01 | pagination fixture | 1 | 1 |
| local-02 | publication recovery fixture | 1 | 1 |
| local-03 | browser authentication fixture | 1 | 1 |
| local-04 | cancellation fixture | 1 | 1 |
| local-05 | eligibility counterexample | 0 | 0 |
| local-06 | revision identity fixture | 1 | 1 |
| **Total** | | **6** | **12** |

The six candidates are **unjudged**, and twelve reference issues await independent adjudication. Source evidence/line validation rejected no additional candidates in this run. A zero reference count on a public case is not a clean-PR assertion. Missing reference matches cannot automatically become false positives. No precision or recall is claimed.

Exact experiment hash: `230b0bae4073472a701eda5aa516984be0c36687d0c04f8148fe91c8def485a2`.

Local artifacts (ignored, not uploaded): `.pr-review/eval/runs/codex-rubric-dev-v1/run.json`, individual case results, and `.pr-review/eval/adjudication/codex-rubric-dev-v1/{worksheet,judgements}.json`. Scoring the untouched worksheet returns `status: incomplete` and null metrics. A repeated `--resume` returned all twelve saved cases without starting any model call.

## Preliminary full-file attempt

Before the windowed context was frozen, a Claude browser batch on full-file packets completed public-01 with no candidates and coverage limitations. The second invocation failed authentication; the batch stopped at 2/12 (one successful result, one failure). It was not retried, and no API fallback was used. The successful call reported about 115k input/cache tokens, motivating a smaller explicitly versioned packet. This failed preliminary batch is not pooled with the windowed Codex experiment or interpreted as a provider-quality comparison. Claude needs its official login refreshed before a future Claude experiment.

No provider API key, hosted judge, GitHub review comment or code rework was used for either experiment. Native usage telemetry is retained in private local results; actual billed cost is unknown. No background process remains after the runs.

## Next decision

Adjudicate the dev worksheet, then implement and evaluate a bounded source-aware verifier. Compare strategies under comparable predeclared budgets before choosing a default. Keep the eight test cases reserved until prompts and strategy are frozen. M5 author assessment and human rework approval remain separate future work.
