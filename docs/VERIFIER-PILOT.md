# Verifier development pilot — 2026-10-14

Baseline: the [original twelve-case development run](EVAL-PILOT.md), requested model `gpt-6.1-sol` through Codex CLI 0.162.1/browser authentication. The eight reserved test cases were not used. All counts below are development evidence with **agent-assisted adjudication**, not independent human ground truth or an official ReviewBench score.

## Baseline adjudication

The original pending worksheet remains intact. A separate `judgements.agent-assisted.json` records a rationale for every candidate and reference issue, bound to original run hash `f9f0658730eee453771b2a23b751febfd3b24e6bc1f444e58e9f988f604232e1`.

| Classification | Count |
|---|---:|
| Supported candidate findings | 6 |
| False-positive candidate findings | 0 |
| Known issues found | 6 |
| Known issues missed | 2 |
| References excluded from the assessable denominator | 4 |

The six supported candidates comprise five authored defect fixtures and the public subtitle-color conflict. The missed issues concern duplicate component bookkeeping and a deployment failure reported as a polling failure. The latter is a low-severity diagnostic defect supported by the original packet. The former required an independent read of `Container.ts` at the immutable public-01 head: `addComponent` pushes without deduplication, and the new replacement path reaches an all-container add loop.

Reference quality matters: two public-01 entries describe that same registration mechanism, and their DOM-duplication claim is stronger than the available evidence. One is counted as the underlying bookkeeping issue with corrected impact; the duplicate reference is excluded. The other exclusions require an unestablished VTT input contract, imported deployment/logger behavior, or an external UI dependency/current side effect. They are not silently counted as clean or automatically converted into misses.

This produces 6/6 candidate precision under these provisional annotations and **6/8 conditional recall among assessable reference issues**. Overall known-issue recall remains null because four references are not assessable as independent in-scope issues. These tiny, author-influenced counts do not establish general accuracy. The independently fetched Container context is stored only with adjudication and was never supplied as an answer or fed into inference.

## Initial protocol and correction

An initial `bounded-source-v1` run completed six CLI invocations. It semantically supported the public subtitle candidate but cited a background selector one line away from the supplied source. The host downgraded that verdict to uncertain and retained the candidate. Five fixture candidates remained supported. No anchor was automatically corrected.

The development protocol was then explicitly changed to `bounded-source-v2`, supplying original line numbers alongside source text. The earlier artifact remains separate; it is not rewritten or scored as the new version. This is a protocol usability correction identified on development data, not evidence of broader model improvement.

## Frozen v2 development run

Experiment hash: `1a683edaaaa980fd6a26786ab7ab87577af13aeee4401da0b13206b3814a3652`.

- Twelve baseline cases handled: six verified and six skipped because they had no candidate findings.
- Six additional browser-CLI invocations, zero provider failures, approximately **58.3 seconds** of summed case duration.
- Six supported, zero rejected, zero uncertain. No annotated true finding was removed.
- No context requests were needed by the live model on these candidates. The two-turn/context branch is covered by adapter fixtures, and an immutable public source read was separately exercised for adjudication. Do not claim the live model exercised source retrieval.
- A resumed run reused all saved cases with **zero new invocations**.

| Outcome | Count |
|---|---:|
| Annotated true findings supported | 6 |
| Annotated true findings rejected | 0 |
| Annotated true findings left uncertain | 0 |
| Annotated false findings rejected | 0 |

This run demonstrates retention and protocol behavior. It **does not demonstrate a precision gain**: the baseline had no annotated false positives for the verifier to remove. The two baseline misses remain misses. The original baseline used twelve calls; final verification added six. The initial development protocol used another six, reported separately rather than hidden in a final-run cost comparison. No equal-budget strategy comparison or cross-provider superiority claim follows.

## Validation and next step

Offline tests cover label isolation, immutable requests and mirrors, line/byte budgets, exact citations, numbered coordinates, one-round enforcement, failed-invocation accounting, browser-only auth, stopped batches, resume, false rejection detection and custom output schemas. Existing provider and publication tests remain applicable; no GitHub comments, fixes, API-key inference or automatic merges were performed by evaluation.

Next, build a clearly separated development challenge set with realistic false-positive counterexamples and source-dependent claims, obtain independent human review of the annotation choices, and compare the bounded verifier with an equal-budget additional-review alternative. Keep the eight test cases reserved. Author assessment and explicit human rework decisions remain M5.
