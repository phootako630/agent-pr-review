# Implementation plan

Created: 2026-10-12. Updated: 2026-10-14. Status: M1–M4 and the M4.5 evaluation baseline merged; a bounded source verifier and development adjudication implemented on `feat/m45-bounded-verifier`; budget-matched strategy comparison and M5 onward remain planned.

## Outcome

A PR created by a local or cloud coding agent is reviewed automatically when ready or updated. Independent agents publish useful GitHub comments; the original author assesses each finding and proposes a response. A human decides before rework. Subsequent pushes trigger verification and review of the new changes. GitHub is the shared workspace, with a CLI for local use and portable author handoffs.

The user confirmed mixed local/cloud authors, automatic reviews, and an explicit human checkpoint after author assessment. These choices supersede the initial mandatory reviewer-debate design. Cross-validation between reviewers is optional; author assessment and human decisions are core.

## Decisions for version 0.1

- Use TypeScript, a supported Node.js LTS release, npm, and a single package. Pin the runtime and dependency versions when implementation starts.
- Coordinate native agent CLIs through subprocess adapters. This retains their repository exploration abilities. Keep adapter contracts compatible with later SDK/API implementations.
- Use GitHub REST through a typed client for metadata and publication; support existing local `gh` authentication without logging tokens. Use Git for immutable source snapshots.
- Begin with independent reviewer sessions. When the author provider is known, default to the other two providers; never count the original author session as an independent reviewer. Reviewer-to-reviewer cross-validation is optional and bounded to one pass.
- Treat evidence as the publication criterion. Model agreement is supporting information, not proof.
- Review is read-only by default. Test execution is a separate opt-in sandbox capability.
- Single-run local reviews default to reports. The recommended continuous worker uses official browser-authenticated CLIs and publishes COMMENT reviews automatically. Provider API-key cloud execution is optional and remains disabled. This supersedes the earlier hosted/API default after the owner clarified subscription usage on 2026-10-13. Use up to 10 published findings and a 10-minute review deadline. Author assessment and human waiting are separate stages.
- Support partial reports when a provider fails. A failed or incomplete review must never appear as a clean review.
- Store local artifacts for CLI runs and retained CI artifacts for hosted runs. GitHub comments and a versioned decision summary expose the shared history; no dedicated database is required initially.
- Support the original author through a portable assessment packet first. Automatic local session resumption and cloud-bot messaging require provider-specific integration and are not promised in version 0.1.
- The author proposes changes but cannot authorize them. Version 0.1 records an explicit authenticated human decision and exports the approved handoff; the user directs the existing coding agent to execute it.

## Milestones

Each milestone is a reviewable vertical slice. Finish and validate one before expanding the workflow.

### M0 — Repository and plan

- [x] Describe scope, architecture, integration references, and delivery order.
- [x] Initialize the Git repository with documentation and ignore rules.
- [x] M1 implementation started on `feat/m1-local-review`.

### M1 — One-agent local review

Deliver CLI argument handling, configuration validation, `doctor`, PR metadata retrieval, fixed source snapshot, diff parser, a Codex adapter, versioned finding validation, and Markdown/JSON reports. Introduce a fake adapter for offline development.

Implementation scope: packet-only Codex review with explicit related-file inclusion. Autonomous source browsing is deferred. Pin the tested Codex CLI protocol to 0.162.1; require an explicit accessible model ID. Use a bare Git snapshot to avoid repository hooks/filters and GitHub patch truncation. See README for commands and partial-run exit codes.

Validation: local type-check/build and 17 automated tests pass. Linux and Windows CI passed on the initial implementation PR. Codex 0.162.1 with `gpt-6.1-sol` identified a seeded bug and reviewed real PR #1 at captured head `eefb0028f67f6a2dcc39144b07b10de8dbb61f9e`, covering all 21 changed files. Its two findings (literal Git pathspec handling and evidence/line overlap) were reproduced with failing tests and fixed. The report correctly remained partial because the provider declared context limitations. See PR checks for the latest revision's validation status.

Acceptance:

- One command reviews a real test PR with Codex and writes a report without GitHub mutations.
- Report records repository, PR number, base/head/merge-base SHA, tool version, provider/model, configuration hash, coverage, and completion status.
- Handle renames, deletions, binary files, truncated patches, pagination, and oversized changes explicitly; omitted content is reported.
- Invalid URLs, missing auth, unavailable CLIs, malformed output, cancellation, and timeouts produce actionable errors.
- Automated fixtures prove diff locations and snapshot consistency. A real provider smoke run validates the actual CLI protocol.

### M2 — Three independent reviewers

Implementation: native Claude Code and Grok adapters, bounded scheduler, per-provider deadlines, schema-v2 reports with candidate retention/provenance, explicit model/auth selection, and optional CLI version pins. Supported protocols are Codex 0.162.1, Claude Code 2.1.293, and Grok 1.0.50. All reviewers share one immutable bounded text packet and use separate empty working directories. Repository exploration remains deferred as established in M1.

Add Claude Code and Grok adapters behind the same interface, provider capability checks, bounded concurrency, separate working directories, and independent first-round prompts. Record runtime and token/cost information when providers expose it.

Acceptance:

- All three agents review the same snapshot and context policy; none sees other agents' findings in round one.
- Each adapter passes contract tests and one live smoke run with credentials supplied by the operator.
- One provider timing out still produces a clearly marked partial report from successful providers.
- Subprocesses are cancelled on deadline, including child processes; credentials and raw environment variables are absent from saved artifacts.
- Model identifiers and CLI versions are configurable and recorded, not guessed by the coordinator.

### M3 — Evidence filtering and reliable GitHub comments

Implementation: schema-v2 report integrity checks, conservative exact-claim grouping, held-candidate/conflict provenance, source revalidation, comment-only reviews, per-PR local locks, atomic journals, owned-marker reconciliation, and explicit partial-report opt-in. Live dedicated PR #3 validated an inline comment/summary, simulated lost-response recovery, repeat publication, and stale-head refusal. The isolated Git environment explicitly enables long paths on Windows. See `docs/PUBLICATION.md` for recovery and concurrency boundaries.

Normalize findings, identify duplicates conservatively, validate evidence and anchors, and publish comments. Retain provider provenance and conflicting claims. Optional cross-validation can enrich results later but is not required for the core handoff workflow.

Acceptance:

- Findings without valid code references, a concrete trigger, or observable impact are held for inspection rather than published as established defects.
- Similar wording alone does not merge unrelated root causes.
- Conflicting claims are clearly marked for human inspection; model agreement alone does not determine correctness.

Implement `publish <report>` with strict schema checks, head/base freshness checks, diff anchor validation, deterministic finding fingerprints, a publication journal, GitHub reconciliation, and bounded retries. Use comment-only reviews initially.

Acceptance:

- In a dedicated test PR, publish an inline comment and summary at the reviewed SHA.
- Publishing the same report twice does not duplicate comments, including after a simulated response timeout.
- Reject stale reports when the PR head or relevant base snapshot changes. Never silently remap stale findings.
- Invalid inline anchors stay in the summary with an explanation instead of a fabricated location.
- Update only comments owned by this tool's publisher and marked with its identifiers; preserve user replies and unrelated comments.
- A changed PR can be reviewed again without automatically deleting historical discussion or resolving threads solely because a finding was not rediscovered.
- Concurrent publishers are serialized per PR in CI; local publication uses a lock and remote reconciliation. Cross-machine races are documented until distributed locking exists.

### M4 — Automatic reviews with local worker + CLI

Preferred implementation: a local GitHub REST poller with explicit browser auth for every reviewer, fixed source snapshots, bounded concurrency, new-revision cancellation, persistent revision/report state, provider pauses, and separate existing publisher journals/locks. Failed/expired/limited providers do not switch to API auth. Partial peers remain usable. The native CLIs retain their actual account entitlements and billing policies; the coordinator cannot enforce account-level paid-overage settings. See `docs/WORKER.md`.

Optional hosted implementation (PR #5 merged): default-branch target/dispatch workflow, isolated API-key reviews, serialized publishers, 30-day data-only artifacts, and durable commit-status intent. This path is not enabled and is not required for the local worker. Its hosted credential/event pilot remains pending separate setup. See `docs/ACTIONS.md`.

Live local pilot: disposable PR #6 was skipped while draft, then reviewed by all three browser-authenticated native CLIs after becoming ready. Its saved partial report published a summary, and repeat polling/restart made no new model call. A continuously running worker detected a follow-up push and published a second partial/inconclusive summary while preserving the first and unrelated bot discussion. Claude authentication expired on that second round; it was paused without API fallback while Codex/Grok results survived. All three initial candidates were held by the existing same-anchor conflict policy, so this pilot does not claim a new inline-comment validation or clean complete coverage. Earlier M3 inline publication remains separately validated.

Local type-check/build and 67 tests pass, with final Linux/Windows status recorded in the implementation PR. Subprocess tests prove an inherited Codex API key is not used by browser mode; red/green tests classify usage-limit and expired OAuth diagnostics without retaining raw private output. An independent Codex review found that recovery previews could discard worker-level uncertainty and permit another model call after a config change. A regression reproduced it; durable publication-attempt state now survives previews until actual reconciliation.

Acceptance:

- A test PR update is detected automatically; a newer revision cancels an active review on the next successful poll. Publication is never cancelled by that poll.
- A draft PR is skipped; marking it ready triggers review. A PR opened ready also triggers review. Bot comments do not recursively trigger review.
- Review runs use an explicitly captured PR head, not an assumed event merge commit. Deduplicate repeated deliveries for the same snapshot and policy.
- Local detection reads PR metadata directly and does not depend on Actions events from the author credential. Actual individual cloud-bot credential paths remain un-inventoried; no direct author-session integration is claimed. Optional hosted execution supports explicit dispatch where events do not deliver.
- Local artifacts/journals persist without automatic deletion, with documented manual cleanup after recovery. Optional hosted artifacts retain 30 days. Logs distinguish partial, failed, stale, paused, previewed, and published outcomes.
- Fork PRs do not automatically receive secrets or execute in a privileged publishing job. The initial policy skips them with a clear status; isolated fork support is later work.
- Provider timeout, missing credentials, and GitHub rate limits have tested behavior.
- Workflow dependencies are pinned and the publisher uses minimum repository permissions.

### M4.5 — Review quality baseline (before M5)

The owner requested evidence for rubric/verification versus mandatory cross-provider review on 2026-10-14. See [evaluation protocol](EVALUATION.md) and [dataset research](EVAL-DATASETS.md). A pinned public-data subset plus original domain fixtures forms a 20-case pilot, with separate inputs/answers and dev/test groups. Local browser CLI evaluation records candidates, coverage, failure and usage telemetry; manual adjudication distinguishes supported, unsupported, duplicate and uncertain findings. No model-quality claim follows from orchestration tests alone.

First slice: data preparation, a repeatable current/rubric baseline, immutable run provenance, explicit invocation budgets, and post-run adjudication tools. Follow-up: an optional [bounded source-aware verifier](VERIFIER.md), separate agent-assisted development judgements, and a [retention pilot](VERIFIER-PILOT.md). A budget-matched multi-provider comparison remains subsequent work. Do not select a winning strategy or proceed to automatic rework from provisional development output. Keep M5 human decisions as planned.

### M5 — Author assessment and human decision

Create a versioned assessment packet containing PR intent, snapshot, stable finding IDs, comment references/content hashes, evidence, prior decisions, and an expected response schema. Associate the author provider and optional session reference through explicit metadata, never by guessing from Git commit identity. Support exporting a handoff and importing a validated assessment from local or cloud sessions.

Acceptance:

- Demonstrate a local author handoff and a cloud author handoff; clearly identify manual transport versus any verified automatic integration.
- Every finding receives `accept`, `disagree`, or `needs_human_decision`, with proposed changes or an evidence-backed explanation. Missing dispositions keep the assessment incomplete.
- Present one compact GitHub decision summary with links to the original comments, proposed fixes, disagreements, and outstanding questions.
- An authenticated maintainer uses an explicit CLI decision command to record per-finding `approve_fix`, `dismiss`, or `defer` choices bound to the assessment hash, finding versions, and reviewed SHA. Publish an append-only decision entry; never infer approval from free-form PR text, an agent response, a reaction, or elapsed time.
- `approve_fix` permits only the specified proposal; an author's `accept` is not authorization. New commits or changed proposals invalidate pending approval for execution until re-assessed.
- Export an approved rework packet for the user to pass to the existing coding agent. Version 0.1 has no built-in code-writing executor; explain that externally operated agents remain under the user's control.
- Preserve disagreements and dismissed findings in history. Neither the author's disagreement nor a human's approval of a fix marks the issue verified as fixed.

### M6 — Revision verification and quality pilot

After a revision, re-check prior approved fixes against the new snapshot and review new changes for regressions. Keep `verified_fixed`, `still_present`, and `cannot_verify` distinct. Repeated disputes return to the human; no automatic modification loop is created.

Acceptance:

- A follow-up push maps previous findings to evidence in the new revision; absence from a new review is not proof of resolution.
- New findings and materially changed proposals require a new assessment and decision.
- Merge remains a human action; comments are not silently resolved on behalf of the author.

Evaluate at least 20 representative PRs with human-labelled findings, including clean changes, regressions, edge cases, misleading instructions, author disagreements, and revised code. Compare individual reviewers with the filtered combined output; evaluate optional reviewer cross-validation separately if implemented.

Acceptance:

- Report actionable-comment precision, seeded-bug recall, duplicate rate, elapsed time, coverage, and available cost data separately.
- Provisional target: at least 80% of published findings are judged actionable by the maintainer, no duplicate comments in repeat-publication fixtures, and complete adapter smoke coverage. Include raw counts because this pilot is small.
- Measure manual handoff steps, time to a human decision, assessment completeness, and whether optional cross-validation improves precision enough to justify its cost.
- Document installation, authentication, configuration, partial-run behavior, publication, and troubleshooting.
- Publish a tagged release only after real-provider and GitHub end-to-end checks pass.

## Suggested implementation layout

```text
src/
  cli/             # commands, configuration, doctor
  core/            # run lifecycle, deadlines, routing
  providers/       # codex, claude, grok, fake adapter
  github/          # PR snapshots, comments, publication reconciliation
  review/          # normalization, deduplication, verification, policy
  handoff/         # author identity, assessment packets and imports
  decisions/       # authenticated human decisions and approved packets
  reports/         # JSON schemas and Markdown rendering
tests/
  fixtures/        # synthetic repositories, diffs, provider responses
  integration/     # adapter contracts and GitHub publisher behavior
docs/
```

## Validation approach

Use unit tests for diff mapping, finding validation, evidence policy, and fingerprints. Use contract tests with recorded/synthetic provider responses for adapters. Use integration tests for cancellation, retry/reconciliation, stale SHA rejection, partial failures, assessment imports, authorization checks, and approval invalidation. A fabricated agent approval must not produce a human decision. Keep real provider and GitHub tests explicitly invoked so ordinary CI does not incur model costs or post comments.

## Dependencies and unresolved choices

- Each provider needs supported noninteractive authentication. Verify installed CLI flags, output schemas, and account eligibility during its milestone; a chat subscription is not assumed to include API usage.
- Native CLI cost reporting may be unavailable. Enforce time/concurrency/round limits and report unknown costs honestly; exact spending caps require a provider path with enforceable usage accounting.
- Start with Linux CI and support Windows/macOS local operation through platform-aware subprocess handling; verify all claimed platforms before release.
- Keep the repository private initially. Decide public release and license separately.
- Exact local applications and cloud bots remain to be inventoried during integration. Portable handoff is the required fallback when original session resumption is unavailable.
- Add SDK adapters, direct author-session transport, an approved-change executor, a GitHub App, distributed jobs, and a dashboard only after the core workflow works.
