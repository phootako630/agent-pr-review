# Architecture and review policy

## Components

The coordinator owns snapshots, run state, routing, deadlines, publication, and handoff records. Reviewer adapters run agents and normalize their findings. Author handoffs carry those findings to the existing local or cloud coding session. Review and assessment are read-only; the human decides before rework. GitHub is the shared review workspace.

| Component | Responsibility |
| --- | --- |
| PR snapshot | Capture PR metadata, base/head revisions, merge base, source, diff, and coverage |
| Provider adapter | Check capabilities, launch agent, constrain tools, parse output, handle cancellation |
| Review pipeline | Independent review, normalization, deduplication, filtering, optional cross-validation |
| Report store | Persist versioned JSON, Markdown, provenance, errors, and publication journal |
| GitHub publisher | Validate freshness/anchors, reconcile existing comments, publish eligible findings |
| Author handoff | Export assessment requests and validate returned author dispositions |
| Human decision log | Record authenticated, scoped decisions and export approved rework packets |

Proposed adapter operations are `probe`, `review`, and `verify`, each with a deadline and cancellation signal. The coordinator validates all returned data. Prefer schema-constrained output where supported; fail explicitly rather than extracting arbitrary prose as trusted findings.

M2 implements `probe` and `review` through a bounded worker scheduler. Capture happens once before fan-out; every reviewer receives the same serialized prompt, with identical context/prompt hashes. The scheduler owns per-provider deadlines and records failures independently. Completed results survive a peer failure or overall cancellation; queued reviewers cancelled before launch have no start timestamp. `verify` remains planned.

Schema-v2 local reports retain a `providers` array with each provider's CLI version, requested/reported model, timing, status, whitelisted usage/cost estimate, schema-valid original candidates, filtered results, and controlled diagnostics. Aggregated findings retain their concatenated M2 representation. M3 emits separate normalized candidates/publication plans and performs explicit GitHub publication. Semantic/fuzzy root-cause matching remains deferred. Temporary credential homes and logs are removed on normal completion/cancellation.

Grok 1.0.50 retains a primary terminal definition despite its tool filter. The adapter denies every tool permission and rejects successful output unless its recorded session contains the exact user prompt, no tool calls/results, and no additional definitions. An empty tools argument retains the default catalog in this CLI, so the adapter supplies an explicit filter and removal list. This is a trusted-CLI enforcement boundary; the local transcript cannot prove what a remote inference service received.

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

`AuthorContext`: explicitly configured provider, local/cloud execution mode, optional session reference, PR intent, and transport capability. A provider name does not imply access to its original session. Record whether assessment came from the original session or a fresh session with a handoff.

`AuthorAssessment`: snapshot and packet hashes, findings/comment versions, author identity, and one disposition per finding: `accept`, `disagree`, or `needs_human_decision`. Include proposed fix scope, evidence, tradeoffs, and questions. Importing this record never authorizes code changes.

`HumanDecision`: authenticated actor, repository/PR, reviewed SHA, assessment hash, finding versions, per-finding `approve_fix`, `dismiss`, or `defer`, proposal scope, and timestamp. Record append-only history and verify maintainer authorization. New revisions or changed proposals invalidate pending execution authorization; prior decisions remain historical evidence.

`RevisionVerification`: previous finding/decision references, new snapshot, verdict (`verified_fixed`, `still_present`, `cannot_verify`), and code/test evidence. Approval to fix and evidence of a completed fix are separate states.

All paths must remain within the snapshot root. Check line ranges against the correct side of the captured diff. Reject unexpected fields where they can affect execution; model output is never shell code or an unrestricted API request.

## Run lifecycle

```text
PR ready/update -> snapshot -> independent reviews -> filter -> publish
                                                               |
                                                               v
assessment handoff -> author proposals -> awaiting human decision
                                               |
                                   scoped approved rework packet
                                               |
                               user directs existing coding agent
                                               |
                                   revision pushed -> verify/review
```

Each stage records success, failure, timeout, or skipped state. A zero-finding result counts as clean only when the requested review coverage completed. Partial runs remain usable as local reports; automated publication requires a complete run by default.

Use bounded concurrency, provider-specific retry rules, and one overall deadline. Do not retry authentication failures as transient errors. Preserve completed stages for inspection; later resumability may reuse them only when snapshot, config, tool version, and prompt hashes match.

The deadline applies to one review run, not human waiting. Assessment and decisions persist as separate stages; no worker stays running while waiting for approval. Human decisions are initially recorded through an authenticated CLI and published as an audit entry on GitHub. Free-form comments, reactions, bot responses, and timeout do not count as authorization. A later GitHub command interface must implement actor authorization and snapshot binding before it can accept decisions.

Version 0.1 exports packets and imports assessments without claiming universal session automation. The original author is asked to assess only and wait. The user forwards the approved packet for execution through their existing tool. The coordinator can enforce its own read-only behavior and packet validity; it cannot control an unrelated agent operated outside it.

## Cross-validation and selection

All reviewers start with the same snapshot and context policy, without seeing one another's outputs. When an author provider is known, default to the other two providers; never reuse the author session as an independent reviewer. Deduplicate candidates conservatively by root cause, code anchor, and trigger; preserve all originating providers. Optional cross-validation routes candidates to another provider in at most one pass, hiding unnecessary provider identity to reduce brand bias.

Eligible findings describe a change-introduced defect, a concrete trigger, observable impact, and valid source evidence. A second reviewer endorsement is optional. Stylistic preferences without a documented requirement are excluded. Conflicting evidence is clearly marked in the decision summary for human inspection rather than presented as a confirmed defect. A majority vote alone cannot qualify a finding.

Group findings by root cause and cap the number of published comments. Summaries explain coverage, unavailable providers, exclusions, and unresolved disagreements. Do not automatically approve, request changes, repair code, or merge in version 0.1.

The author must assess every published finding: acceptance includes a proposed fix, disagreement includes evidence, and ambiguity includes a concrete human question. Disagreement does not close a finding. Human dismissal records an accepted decision, not proof that the reviewer was wrong. Following a revision, examine prior findings and the new diff; do not equate failure to rediscover a finding with a verified fix.

## Publication semantics

M3 implements the local CLI path. It re-fetches Git source with the report's bounded context policy and compares the complete packet, including metadata and exclusions, before any write. Integrity/provenance checks establish consistency of an operator-supplied artifact, not cryptographic evidence of a model session. Unknown schema fields and inconsistent provider/aggregate/hash records are refused. Partial coverage requires explicit opt-in.

A COMMENT review carries the initial summary and new inline findings at an explicit commit. Per-PR local locks serialize publishers sharing one state directory. Atomic journals record intent before writes. Read requests have bounded retries; create requests are not automatically retried. Ambiguous create responses are reconciled using remote markers, owner IDs, original commit/anchor metadata, and submitted review state. Unresolved outcomes stop without a repeat POST. Reused owned inline comments can receive updated bodies; historical revisions and replies are never deleted or resolved.

Before a new create, unresolved intents in other journals for the same PR snapshot are also checked. A new report hash or changed comment budget cannot bypass an earlier invisible create. The original invocation must be reconciled first.

Only the publisher has GitHub write credentials. Treat report files as untrusted: validate their schema, repository identity, provenance, selection policy, paths, and anchors before sending requests. Re-fetch PR state immediately before publication and bind the review to the captured head SHA. GitHub cannot make a client-side freshness check atomic with a later push; if the head changes concurrently, identify the reviewed SHA and flag the run as superseded instead of claiming it reviewed the new head.

Use one coherent comment-only review for a new publication where practical. Reconcile tool-owned comments before retries, update existing owned comments when appropriate, and never blindly repeat a timed-out creation request. Fingerprints include repository/PR identity and a normalized root cause/code anchor; exact-run identity additionally includes the head SHA. Cross-revision semantic matching is conservative and must not erase historical discussions.

Keep findings that cannot be anchored in a summary. GitHub line comments require validated diff coordinates; a line number in an arbitrary source file is insufficient. See the official references for review/comment schemas.

## Deployment progression

1. Build and test the CLI engine locally, with file artifacts and explicit publication.
2. Ship the MVP with automatic GitHub Actions review, PR-level concurrency, and separate publishing permissions. Review ready PRs when opened, reopened, marked ready, or updated; skip drafts and untrusted forks under the initial policy. Retain CI artifacts and expose durable findings and decisions on GitHub.
3. Use portable handoffs to local/cloud author sessions, authenticated human decisions, and user-directed approved rework. Add automatic author transport only for verified provider capabilities.
4. Add a GitHub App, webhook ingestion, queue, database, and distributed locks if multi-repository demand justifies them.

Native CLI reviewer adapters can run in CI as well as locally when supported credentials are configured. The original author can remain in its existing environment. Verify actual bot-created PR event delivery during integration; a workflow-created event is not assumed to trigger another workflow under every credential type. The MVP needs no dedicated application server or dashboard.
