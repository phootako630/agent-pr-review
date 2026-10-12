# Automatic hosted reviews

M4 uses the existing CLI on GitHub-hosted Linux runners. The repository owner chose API-key secrets; local browser sessions are not copied to CI. The original coding agent can remain local or cloud based. This workflow posts reviews only; author assessment and human decisions are M5.

## Setup

1. Merge the workflow onto the repository's default branch. `pull_request_target` executes that trusted workflow, not a proposed workflow from a PR. Manual dispatch also requires the workflow on the default branch.
2. Set accessible API model IDs in `.github/agent-review.json`. The initial `CONFIGURE_*` values intentionally refuse to run. Models available to a browser subscription may differ from API account access.
3. Add repository Actions secrets `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `XAI_API_KEY` for the selected reviewers. Configure only the providers you intend to run; fake and browser-auth reviewers are refused by this hosted path. Missing selected-provider secrets fail before any model call. Invalid keys, unavailable models, or a provider timeout are recorded by the scheduler; usable peers can produce an explicitly partial report.
4. Set repository Actions variable `AGENT_REVIEW_ENABLED` to `true`. This enables automatic provider calls and comment-only publication. API usage is billed to the configured provider accounts. The trusted configuration opts into partial reports and caps inline comments at 10. Configure those policies before enabling.
5. Open a ready, same-repository PR targeting the default branch. Inspect **Independent agent review** in Actions. Try draft → ready, a new push, manual repeat, and a seeded-defect fixture. Use disposable PRs for validation.

Secret values are never CLI arguments. Only the review step receives provider secrets; only the publisher job receives PR write permissions. The standard Actions `GITHUB_TOKEN` is used for repository access. General third-party App installation tokens are not supported as publisher identities by this version.

## Triggers and coding bots

`opened`, `reopened`, `ready_for_review`, and `synchronize` trigger `pull_request_target`. Drafts, forks (including deleted fork repositories), closed PRs, and alternate base branches are explicit skips. Comment events are not subscribed. A stale event head or a head/base changing during capture is skipped. The snapshot is fetched as Git data using exact SHAs, not checked out or executed.

Use **Run workflow** with the PR number for manual retries, or:

```sh
node dist/cli.js dispatch https://github.com/OWNER/REPO/pull/123
```

`dispatch` authenticates using `GH_TOKEN`/`GITHUB_TOKEN` or `gh auth token`, resolves the default branch, and invokes `agent-review.yml`. It reports request acceptance; the Actions run reports eligibility, missing setup, review results, and publication. It never claims a dispatched request already completed.

For a coding bot running in another Actions workflow, explicitly dispatch after it opens or updates its PR:

```sh
gh workflow run agent-review.yml --repo "$GITHUB_REPOSITORY" --ref main -f pr="$PR_NUMBER"
```

Replace `main` with the repository's default branch and grant that author job `actions: write`. Keep the PR number in an environment variable instead of interpolating untrusted text into shell code. GitHub documents that `workflow_dispatch` and `repository_dispatch` can trigger workflows with `GITHUB_TOKEN`. Its current documentation also describes approval-required `pull_request` runs for some bot-generated events; this workflow uses `pull_request_target`, so do not assume automatic delivery from a default-token coding bot. The explicit dispatch is the supported fallback. PAT/App-authenticated authors can ordinarily trigger events, but every actual author credential path still needs a live event test.

This milestone has not inventoried or validated the user's individual cloud-bot credentials. No third-party bot callback or author-session messaging is claimed. See the [official trigger documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## Execution and trust

```text
default-branch workflow/code/config
  gate: event + live metadata → fixed text packet
  review: independent native CLI sessions → explicit report artifact
  publish: fresh source + schema/provenance + durable intent → COMMENT review
```

All jobs check out `github.sha` from the default-branch event context with persisted Git credentials disabled. Dispatches from other refs are skipped. No job checks out a PR head, installs its packages, runs its scripts, or executes its tests. Provider subprocesses receive the immutable text packet in empty directories under the existing tool restrictions. Action revisions and native CLI package versions/integrities are pinned; npm lifecycle scripts are disabled. A small trusted bootstrap copies/decompresses the pinned native binaries.

Review jobs have PR-specific concurrency with cancellation enabled. A newer eligible review replaces a running review. Publisher jobs have a separate PR-specific group with cancellation disabled. GitHub concurrency can replace a pending job rather than guarantee FIFO; correctness comes from freshness and durable intent, not scheduling order. A push can invalidate a report while publication is in flight; GitHub cannot make that check atomic with posting. The review always identifies its reviewed SHA and refuses to claim it reviewed a newer head.

Fork and draft gates run before provider secrets are exposed. Historical recovery artifacts must originate from this repository's review workflow, a supported target/dispatch event, and a coordinator revision in default-branch history. The original source run/attempt, snapshot, configuration, policy, report identity, and current packet must match. Artifacts are data inputs and are never executed. Rewriting default-branch history can intentionally prevent old-artifact recovery.

## Durable publication and recovery

The review artifact is uploaded successfully before the publisher starts. Immediately before any new review POST, the publisher creates a **pending commit status** bound to PR + head/base/merge-base snapshot. It stores the publication ID, delivery ID, and originating Actions run/attempt. An unknown status-create response stops before any PR write. A missing/unknown review-create response is reconciled through the owned remote marker without a second POST.

This commit status survives runner loss and artifact expiry. It is intentionally separate from ephemeral local journals. The delivery ID includes the complete source packet, review/configuration/publication policies, prompt, tool version, and trusted coordinator SHA; report run timestamps do not cause repeat delivery. Completed matching deliveries are skipped after checking the owned remote summary. A publisher also rechecks for a completed duplicate after entering its serialized job, closing the race with an earlier gate.

An existing pending intent forces reuse of the **original report and original policy**. A fresh runner invokes publication in reconciliation-only mode and cannot create a review. Changing configuration, comment budget, or report ID cannot bypass uncertainty for the same snapshot. If a reservation was written but the runner died before posting, reconciliation conservatively stops even though no review may exist.

Artifacts retain source/report data for **30 days**. Only named `gate.json`, `manifest.json`, report files, plans/previews, and receipts are uploaded; provider credential homes and raw logs are excluded. If an original artifact expires or disappears, automatic recovery stops. Preserve the artifact during investigation. There is no automatic clear/reset command: a maintainer must inspect the original run and GitHub review state before deciding how to recover. Do not delete a pending status or change markers merely to force a retry. A genuinely new head/base is a separate historical snapshot.

The publisher needs `contents: read`, `pull-requests: write`, `statuses: write`, and `actions: read`. The gate has read permissions only; the review has `contents: read` and `actions: read`. Commit statuses are coordination records, not approvals, rework authorization, or claims of clean coverage. Review summaries expose complete/partial/failed provider status. Workflow logs distinguish skips, stale captures, missing setup, review result, recovery, publication, and reconciliation.

## Validation status

Automated transport tests cover missing credentials, event/ref/fork guards, policy/source identity, rate-limited reads/reservations, untrusted artifact workflows/revisions, lost reservation/create/receipt responses, fresh-runner recovery, changed-report uncertainty, and repeat delivery. Existing provider integration fixtures cover timeouts and partial peers; publication fixtures cover stale SHAs and inline reconciliation. Native protocol probes run on Linux and Windows without credentials/model calls.

An independent Codex packet review identified a gate-parser serialization defect: rebuilding a snapshot in schema field order changed its exact JSON hash. A regression test reproduced the mismatch; validation now preserves the original captured object and verifies gate integrity before review. CI also compares the actual full native version strings with the hosted configuration's version pins, rather than merely printing versions.

Live automatic ready/update/draft/cancellation/bot-dispatch tests remain **pending** until this workflow is merged, API model IDs are configured, and secrets are supplied. Local M2/M3 browser-auth and publication runs do not count as hosted API validation. Do not mark M4 acceptance complete until the live pilot is recorded.
