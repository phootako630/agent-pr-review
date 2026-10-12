# Implementation plan

Created: 2026-10-12. Status: proposed implementation, ready to build.

## Outcome

A developer can supply a GitHub PR URL, obtain independent reviews from Codex, Claude Code, and Grok, inspect evidence and disagreements, and publish a small set of useful inline comments without duplicates on repeat runs. CI later runs the same CLI.

## Decisions for version 0.1

- Use TypeScript, a supported Node.js LTS release, npm, and a single package. Pin the runtime and dependency versions when implementation starts.
- Coordinate native agent CLIs through subprocess adapters. This retains their repository exploration abilities. Keep adapter contracts compatible with later SDK/API implementations.
- Use GitHub REST through a typed client for metadata and publication; support existing local `gh` authentication without logging tokens. Use Git for immutable source snapshots.
- Begin with one independent review per provider and one verification pass per unique finding. Route verification to a different provider, batch related findings, and cap output and elapsed time.
- Treat evidence as the publication criterion. Model agreement is supporting information, not proof.
- Review is read-only by default. Test execution is a separate opt-in sandbox capability.
- Default to local reports, up to 10 published findings, two rounds, and a 10-minute overall deadline. Tune these provisional limits against measured runs.
- Support partial reports when a provider fails. A failed or incomplete review must never appear as a clean review.
- Store artifacts locally; no database or hosted service for the MVP.

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

### M3 — Cross-review and evidence filtering

Normalize findings, identify likely duplicates, and request independent verification. Each verifier returns `supported`, `refuted`, or `insufficient_evidence`, with code references and reasoning. Maintain finding provenance and unresolved disagreements in the report.

Acceptance:

- A known bug and a plausible false positive fixture are respectively retained and rejected or held for manual inspection.
- Similar wording alone does not merge unrelated root causes.
- A finding needs valid source evidence, a concrete trigger and impact, and independent support before automatic publication eligibility.
- Refuted, unverified, or disputed findings remain visible locally but are excluded from automatic publication.
- If an author agent is explicitly configured, exclude it from independent verification of its own change where another provider is available.
- No third debate round is created; budget exhaustion stops further calls and marks the report incomplete.

### M4 — Reliable GitHub comments

Implement `publish <report>` with strict schema checks, head/base freshness checks, diff anchor validation, deterministic finding fingerprints, a publication journal, GitHub reconciliation, and bounded retries. Use comment-only reviews initially.

Acceptance:

- In a dedicated test PR, publish an inline comment and summary at the reviewed SHA.
- Publishing the same report twice does not duplicate comments, including after a simulated response timeout.
- Reject stale reports when the PR head or relevant base snapshot changes. Never silently remap stale findings.
- Invalid inline anchors stay in the summary with an explanation instead of a fabricated location.
- Update only comments owned by this tool's publisher and marked with its identifiers; preserve user replies and unrelated comments.
- A changed PR can be reviewed again without automatically deleting historical discussion or resolving threads solely because a finding was not rediscovered.
- Concurrent publishers are serialized per PR in CI; local publication uses a lock and remote reconciliation. Cross-machine races are documented until distributed locking exists.

### M5 — GitHub Actions

Package the same CLI for a manually triggered workflow first, then add automatic PR triggers for trusted repository branches. Separate review execution from the step that has permission to publish.

Acceptance:

- A test PR update triggers a run; a newer revision cancels superseded work through a PR-specific concurrency group.
- Review artifacts are retained with an explicit retention period; logs distinguish clean, partial, failed, stale, and published outcomes.
- Fork PRs do not automatically receive secrets or execute in a privileged publishing job. The initial policy skips them with a clear status; isolated fork support is later work.
- Provider timeout, missing credentials, and GitHub rate limits have tested behavior.
- Workflow dependencies are pinned and the publisher uses minimum repository permissions.

### M6 — Quality pilot and version 0.1 release

Evaluate at least 20 representative PRs with human-labelled findings, including clean changes, regressions, edge cases, and misleading instructions embedded in source text. Compare individual reviewers, their union, and the filtered cross-review output.

Acceptance:

- Report actionable-comment precision, seeded-bug recall, duplicate rate, elapsed time, coverage, and available cost data separately.
- Provisional target: at least 80% of published findings are judged actionable by the maintainer, no duplicate comments in repeat-publication fixtures, and complete adapter smoke coverage. Include raw counts because this pilot is small.
- Record whether cross-review improves precision enough to justify its latency and cost; adjust the default policy from evidence.
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
  reports/         # JSON schemas and Markdown rendering
tests/
  fixtures/        # synthetic repositories, diffs, provider responses
  integration/     # adapter contracts and GitHub publisher behavior
docs/
```

## Validation approach

Use unit tests for diff mapping, finding validation, evidence policy, and fingerprints. Use contract tests with recorded/synthetic provider responses for adapters. Use integration tests for cancellation, retry/reconciliation, stale SHA rejection, and partial failures. Keep real provider and GitHub tests explicitly invoked so ordinary CI does not incur model costs or post comments.

## Dependencies and unresolved choices

- Each provider needs supported noninteractive authentication. Verify installed CLI flags, output schemas, and account eligibility during its milestone; a chat subscription is not assumed to include API usage.
- Native CLI cost reporting may be unavailable. Enforce time/concurrency/round limits and report unknown costs honestly; exact spending caps require a provider path with enforceable usage accounting.
- Start with Linux CI and support Windows/macOS local operation through platform-aware subprocess handling; verify all claimed platforms before release.
- Keep the repository private initially. Decide public release and license separately.
- Add SDK adapters, a GitHub App, automatic remediation, distributed jobs, and a dashboard only after the pilot shows value.
