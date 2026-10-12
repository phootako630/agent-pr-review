# Implementation plan

Created: 2026-10-12. Status: proposed implementation, ready to build.

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
- Local commands default to reports; configured CI publishes reviews automatically. Use up to 10 published findings and a 10-minute review deadline. Author assessment and human waiting are separate stages, not part of that timeout. Tune provisional limits against measured runs.
- Support partial reports when a provider fails. A failed or incomplete review must never appear as a clean review.
- Store local artifacts for CLI runs and retained CI artifacts for hosted runs. GitHub comments and a versioned decision summary expose the shared history; no dedicated database is required initially.
- Support the original author through a portable assessment packet first. Automatic local session resumption and cloud-bot messaging require provider-specific integration and are not promised in version 0.1.
- The author proposes changes but cannot authorize them. Version 0.1 records an explicit authenticated human decision and exports the approved handoff; the user directs the existing coding agent to execute it.

## Milestones

Each milestone is a reviewable vertical slice. Finish and validate one before expanding the workflow.

### M0 — Repository and plan

- [x] Describe scope, architecture, integration references, and delivery order.
- [x] Initialize the Git repository with documentation and ignore rules.
- [ ] Implementation starts at M1; no working CLI is claimed at this stage.

### M1 — One-agent local review

Deliver CLI argument handling, configuration validation, `doctor`, PR metadata retrieval, fixed source snapshot, diff parser, a Codex adapter, versioned finding validation, and Markdown/JSON reports. Introduce a fake adapter for offline development.

Acceptance:

- One command reviews a real test PR with Codex and writes a report without GitHub mutations.
- Report records repository, PR number, base/head/merge-base SHA, tool version, provider/model, configuration hash, coverage, and completion status.
- Handle renames, deletions, binary files, truncated patches, pagination, and oversized changes explicitly; omitted content is reported.
- Invalid URLs, missing auth, unavailable CLIs, malformed output, cancellation, and timeouts produce actionable errors.
- Automated fixtures prove diff locations and snapshot consistency. A real provider smoke run validates the actual CLI protocol.

### M2 — Three independent reviewers

Add Claude Code and Grok adapters behind the same interface, provider capability checks, bounded concurrency, separate working directories, and independent first-round prompts. Record runtime and token/cost information when providers expose it.

Acceptance:

- All three agents review the same snapshot and context policy; none sees other agents' findings in round one.
- Each adapter passes contract tests and one live smoke run with credentials supplied by the operator.
- One provider timing out still produces a clearly marked partial report from successful providers.
- Subprocesses are cancelled on deadline, including child processes; credentials and raw environment variables are absent from saved artifacts.
- Model identifiers and CLI versions are configurable and recorded, not guessed by the coordinator.

### M3 — Evidence filtering and reliable GitHub comments

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

### M4 — Automatic GitHub Actions reviews

Package the same CLI for automatic ready/updated PR reviews on trusted repository branches, plus manual retry. Use `opened`, `reopened`, `ready_for_review`, and `synchronize` events with a draft guard. Separate review execution from the step that has permission to publish. This is core MVP behavior, not an optional later deployment.

Acceptance:

- A test PR update triggers a run; a newer revision cancels superseded work through a PR-specific concurrency group.
- A draft PR is skipped; marking it ready triggers review. A PR opened ready also triggers review. Bot comments do not recursively trigger review.
- Review runs use an explicitly captured PR head, not an assumed event merge commit. Deduplicate repeated deliveries for the same snapshot and policy.
- Test PR creation/push using each actual coding-bot credential path: events generated with a workflow's default token may not trigger another workflow. Use a supported authenticated dispatch or App-based path where necessary, and expose an explicit skipped/failed status when unavailable.
- Review artifacts are retained with an explicit retention period; logs distinguish clean, partial, failed, stale, and published outcomes.
- Fork PRs do not automatically receive secrets or execute in a privileged publishing job. The initial policy skips them with a clear status; isolated fork support is later work.
- Provider timeout, missing credentials, and GitHub rate limits have tested behavior.
- Workflow dependencies are pinned and the publisher uses minimum repository permissions.

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
