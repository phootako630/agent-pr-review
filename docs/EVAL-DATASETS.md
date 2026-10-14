# Public datasets for the M4.5 pilot

Research checked on 2026-10-14. Use **GitHub ReviewBench** for the first public cases. This is a source and integration assessment, not a review-quality result. No upstream setup scripts, benchmark executables, or model calls were run during this investigation.

## Selected source: ReviewBench

Pin `review-bench/ReviewBench` to **`5bba258937cc7d43577ce9a81a389a6550a20fa9`**. The repository provides 219 tasks, golden findings, and repository mirrors. Its root license and README explicitly identify the repository as MIT. Preserve its copyright and permission notice when importing substantial material. The website footer separately links a CC BY-NC notice; that is not the license stated in this repository. Source repository code may carry its own license; retain those notices in any downloaded source cache. [Repository README](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/README.md), [MIT license](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/LICENSE)

The manifest is a JSON array. Each row includes `repo`, `pr_number`, `pr_url`, full `base` and `head` SHAs, `title`, `body`, `nwo`, `language`, `repo_size_kb`, `lines_added`, `lines_removed`, and `files_changed`. Use the pinned SHAs, never the current PR head. The methodology explicitly identifies the recorded head as the state before author follow-up fixes. The input diff is `base...head`. [Manifest](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/corpus/manifest.json), [Snapshot methodology §3.2](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/docs/METHODOLOGY.md#32-pull-request-selection), [Agent contract](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/AGENT_CONTRACT.md)

Golden files follow `golden/<owner>_<repo>_<pr>-<head-prefix8>.json`. Each contains `{ pr_key, pr, findings }`; `pr` binds repository, PR number, base and head. Findings include location, message, `tp_fp` (observed lowercase `tp`), severity, category, scope, context required, justifications, and producer/source metadata. These are **answers**, not reviewer input. [Example file schema](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/golden/axios_axios_10836-9cd706cc.json)

Mirrors are named `https://github.com/review-bench/<owner>_<repo>` and retain the task commits. Prefer those frozen objects if the original history disappears. The official 25-task set is a subset of the full corpus, not a hidden holdout. [Mirror and subset documentation](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/README.md#what-is-in-the-repository)

## Proposed ten-case public pilot

Metadata-only selection: five TypeScript, two JavaScript, three Python cases; ten distinct repositories; at most ten changed files and 350 added plus removed lines. This favors a manageable CLI pilot and is not representative of the complete corpus. Full SHAs and exact download URLs were supplied to the importer separately.

| Repository | PR | Language | Files | Added + removed |
|---|---:|---|---:|---:|
| bitmovin/bitmovin-player-ui | 848 | TypeScript | 4 | 206 |
| capawesome-team/cli | 127 | TypeScript | 1 | 36 |
| playcanvas/editor | 1955 | TypeScript | 2 | 166 |
| pnp/cli-microsoft365 | 7191 | TypeScript | 8 | 160 |
| namehash/ensnode | 1938 | TypeScript | 9 | 35 |
| axios/axios | 10836 | JavaScript | 1 | 12 |
| alexbol99/flatten-js | 244 | JavaScript | 7 | 85 |
| nipoppy/nipoppy | 964 | Python | 5 | 52 |
| YasserShkeir/django-smart-ratelimit | 25 | Python | 10 | 219 |
| torchfont/torchfont | 133 | Python | 6 | 204 |

All values above are from the [pinned manifest](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/corpus/manifest.json). There are no claims here that the selected examples are clean, executable, or exhaustively labeled.

## Leakage and interpretation

Keep reference messages, labels, justifications, post-review fixes, prior model outputs, and expected finding counts outside the reviewer packet and its working directory. Allow only the immutable source packet, original task description after inspection, and common rubric. Review upstream title/body for answer contamination before freezing an evaluation. A new isolated session avoids cross-case memory; model pretraining exposure to public cases remains unknown.

Freeze our own development and holdout partitions before prompt iteration. Public benchmark samples are not secret test cases. Do not use an evaluation case as a few-shot example. Score only after candidate generation. The reference set is incomplete: a finding that does not match a known issue requires independent adjudication instead of automatically counting as false. The source rubric also permits some pre-existing issues, while our PR policy may require introduced or exacerbated defects; report that policy difference explicitly. [ReviewBench labeling, scope, and limitations](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/docs/METHODOLOGY.md)

Our local manual scoring is not an official ReviewBench leaderboard score. The upstream standalone judge uses provider credentials; importing the dataset does not require running that judge or adopting its API route. [Offline evaluation](https://github.com/review-bench/ReviewBench/blob/5bba258937cc7d43577ce9a81a389a6550a20fa9/docs/OFFLINE_EVAL.md)

## Other sources checked

**Martian Code Review Bench:** pin `e616e849755441da38f18bf3adba2c9583b03803`. MIT; fifty offline PRs across five projects, with golden JSON grouped by repository. Those files expose PR URLs and comments but do not themselves pin historical base/head SHAs, so they need extra snapshot verification before becoming runner inputs. Useful as an additional cohort, unnecessary for the first import. [README](https://github.com/withmartian/code-review-benchmark/blob/e616e849755441da38f18bf3adba2c9583b03803/README.md), [License](https://github.com/withmartian/code-review-benchmark/blob/e616e849755441da38f18bf3adba2c9583b03803/LICENSE), [Golden file example](https://github.com/withmartian/code-review-benchmark/blob/e616e849755441da38f18bf3adba2c9583b03803/offline/golden_comments/cal_dot_com.json)

**c-CRAB:** pin `856dfa3102b8996d168c4f195217b7603e1d1bc6`. The release describes 410 JSONL instances derived from SWE-CARE, with retained reference comments and a pipeline involving Docker, generated tests, and comment resolution. There was no root LICENSE in the inspected tree and GitHub reported `license: null`; do not infer a redistribution grant from public visibility. Its executable validation design is relevant to a future stage, but it is a heavier and less clear import for this pilot. [README](https://github.com/c-CRAB-Benchmark/dataset/blob/856dfa3102b8996d168c4f195217b7603e1d1bc6/README.md), [Inspected tree](https://github.com/c-CRAB-Benchmark/dataset/tree/856dfa3102b8996d168c4f195217b7603e1d1bc6)

## Exact download endpoints

- Manifest: `https://raw.githubusercontent.com/review-bench/ReviewBench/5bba258937cc7d43577ce9a81a389a6550a20fa9/corpus/manifest.json`
- Official small subset: `https://raw.githubusercontent.com/review-bench/ReviewBench/5bba258937cc7d43577ce9a81a389a6550a20fa9/corpus/test/test.json`
- Golden example: `https://raw.githubusercontent.com/review-bench/ReviewBench/5bba258937cc7d43577ce9a81a389a6550a20fa9/golden/axios_axios_10836-9cd706cc.json`
- License: `https://raw.githubusercontent.com/review-bench/ReviewBench/5bba258937cc7d43577ce9a81a389a6550a20fa9/LICENSE`
- Tree API: `https://api.github.com/repos/review-bench/ReviewBench/git/trees/5bba258937cc7d43577ce9a81a389a6550a20fa9?recursive=1`
