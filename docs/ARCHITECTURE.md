# Architecture and review policy

## Components

The coordinator owns snapshots, run state, routing, deadlines, and publication. Provider adapters run the native agents and translate their outputs into a common schema. Agents can inspect source context but cannot publish directly.

| Component | Responsibility |
| --- | --- |
| PR snapshot | Capture PR metadata, base/head revisions, merge base, source, diff, and coverage |
| Provider adapter | Check capabilities, launch agent, constrain tools, parse output, handle cancellation |
| Review pipeline | Independent review, normalization, deduplication, cross-validation, filtering |
| Report store | Persist versioned JSON, Markdown, provenance, errors, and publication journal |
| GitHub publisher | Validate freshness/anchors, reconcile existing comments, publish eligible findings |

Proposed adapter operations are `probe`, `review`, and `verify`, each with a deadline and cancellation signal. The coordinator validates all returned data. Prefer schema-constrained output where supported; fail explicitly rather than extracting arbitrary prose as trusted findings.

## Snapshot and trust boundaries

Record both PR base/head SHA and the merge base used for comparison. Review the head checkout against the captured comparison basis. Use a separate checkout or container per provider and never allow competing writes to a user's active worktree.

PR titles, descriptions, comments, code, and repository instruction files are untrusted input. They may describe project requirements, but must not grant tools, alter publication policy, expose credentials, or override the coordinator's review instructions. Load trusted review policy from the operator configuration or trusted base revision. Enforce restrictions outside prompts: read-only mounts where practical, tool restrictions, sanitized environments, and bounded network access. Confirm native CLI automatic instruction loading during integration; do not claim isolation until tested.

Test execution can run PR-controlled code and therefore requires an isolated disposable environment. The default inspection path does not execute repository install scripts or tests. Provider credentials are limited to the relevant adapter; GitHub write credentials never enter an agent environment. Review artifacts exclude credentials and use configurable retention.

## Data contracts

The implementation will version and validate these contracts before execution and publication.

`ReviewRun`: schema version, run ID, repository identity, PR number, base/head/merge-base SHA, context/configuration hashes, provider/model/tool versions, timings, coverage and exclusions, stage results, usage if available, final status.

`Finding`: stable internal ID, origin provider, title, severity (`critical`, `high`, `medium`, `low`), category, repository-relative path, side (`LEFT`/`RIGHT`), start/end line, claim, trigger, impact, supporting source references, and optional remediation. Model confidence may be stored but is not evidence.

`Verification`: finding ID, verifier provider, verdict, supporting or contradicting code references, explanation, and any reproduction result. A verifier can independently inspect relevant source; it must not merely vote on the original prose.

`PublicationRecord`: finding fingerprint, reviewed SHA, report/policy hash, publisher identity, remote review/comment IDs, operation state, and timestamps. Stable hidden markers allow remote reconciliation after interrupted requests.

All paths must remain within the snapshot root. Check line ranges against the correct side of the captured diff. Reject unexpected fields where they can affect execution; model output is never shell code or an unrestricted API request.

## Run lifecycle

```text
snapshot -> independent_review -> normalize -> cross_validate -> report
                                                               |
                                              explicit publish/policy
                                                               v
                                            freshness_check -> reconcile -> publish
```

Each stage records success, failure, timeout, or skipped state. A zero-finding result counts as clean only when the requested review coverage completed. Partial runs remain usable as local reports; automated publication requires a complete run by default.

Use bounded concurrency, provider-specific retry rules, and one overall deadline. Do not retry authentication failures as transient errors. Preserve completed stages for inspection; later resumability may reuse them only when snapshot, config, tool version, and prompt hashes match.

## Cross-validation and selection

All reviewers start with the same snapshot and context policy, without seeing one another's outputs. Deduplicate candidates conservatively by root cause, code anchor, and trigger; preserve all originating providers. Route each candidate to a different provider for verification, selecting a non-originating provider when available. Hide unnecessary provider identity from the verifier to reduce brand bias.

Eligible findings describe a change-introduced defect, a concrete trigger, observable impact, valid source evidence, and independent support. Stylistic preferences without a documented requirement are excluded. Evidence disputes or unavailable verification remain in the local report for human inspection. A majority vote alone cannot qualify a finding.

Group findings by root cause and cap the number of published comments. Summaries explain coverage, unavailable providers, exclusions, and unresolved disagreements. Do not automatically approve, request changes, repair code, or merge in version 0.1.

## Publication semantics

Only the publisher has GitHub write credentials. Treat report files as untrusted: validate their schema, repository identity, provenance, selection policy, paths, and anchors before sending requests. Re-fetch PR state immediately before publication and bind the review to the captured head SHA. GitHub cannot make a client-side freshness check atomic with a later push; if the head changes concurrently, identify the reviewed SHA and flag the run as superseded instead of claiming it reviewed the new head.

Use one coherent comment-only review for a new publication where practical. Reconcile tool-owned comments before retries, update existing owned comments when appropriate, and never blindly repeat a timed-out creation request. Fingerprints include repository/PR identity and a normalized root cause/code anchor; exact-run identity additionally includes the head SHA. Cross-revision semantic matching is conservative and must not erase historical discussions.

Keep findings that cannot be anchored in a summary. GitHub line comments require validated diff coordinates; a line number in an arbitrary source file is insufficient. See the official references for review/comment schemas.

## Deployment progression

1. Local CLI with file artifacts and explicit publication.
2. GitHub Actions runs the same CLI, with PR-level concurrency and separate publishing permissions.
3. A GitHub App with webhook ingestion, queue, durable storage, and distributed locks if multi-repository demand justifies it.

The native CLI orchestration approach is the agreed project direction. A hosted agent framework is not required for the initial finite two-round workflow.
