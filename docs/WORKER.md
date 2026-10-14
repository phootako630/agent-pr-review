# Local worker + official CLI

The default deployment is a worker on your own computer, using browser-authenticated Codex, Claude Code, and Grok CLIs. This choice supersedes the earlier default of API-key inference on GitHub-hosted runners. GitHub remains the shared PR/comment workspace; the optional hosted path in `ACTIONS.md` stays disabled unless separately configured.

## Install and start

Use Node.js 24.18.0, Git, and an authenticated `gh` account with access to the repository. From the trusted coordinator checkout:

```sh
npm ci --ignore-scripts
npm run build
npm ci --ignore-scripts --prefix tools/agents
node tools/agents/bootstrap.mjs
```

The bootstrap supports Linux/Windows x64 and prepares pinned native binaries without npm lifecycle scripts. `npm run worker` adds their directories to the child process PATH, so it does not replace your global CLI installation. On another supported local platform, supply the tested official CLIs on PATH.

Sign in using the official CLIs (`codex login`, `claude auth login`, `grok login`). File-backed credentials are required by the current adapters; keychain-only credentials are not supported. Choose model IDs available through your subscriptions in `examples/worker.browser.json`. Its defaults are the IDs used in earlier native CLI smokes, not universal entitlements. Keep this configuration in your trusted coordinator checkout; do not load it from PR source.

```sh
# Start continuous detection + COMMENT publication:
npm run worker -- OWNER/REPO

# Test one chosen PR with model calls but no GitHub writes:
npm run worker -- OWNER/REPO --pr 123 --once --preview

# Publish the saved successful preview without another model call:
npm run worker -- OWNER/REPO --pr 123 --once

# Inspect durable state and paused providers:
node dist/cli.js worker status OWNER/REPO
```

`--once` polls once and waits for up to `maxActivePrs` jobs; it does not drain every open PR or monitor new heads during that wait. The normal continuous worker polls every 30 seconds by default. It requires the computer/process to stay online. It catches up on ready open PRs after sleep/restart and reviews the latest visible revision; it is not an event log of every intermediate commit. Start/stop a foreground process with your terminal and Ctrl+C. This milestone does not install an OS service or leave an unattended background worker running for you.

## Authentication and cost routing

Every selected live reviewer must explicitly specify `auth: "browser"`. The worker refuses fake reviewers, API-key auth, and automatic auth selection. Provider processes receive an isolated environment and the supported browser credential payload; inherited `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `XAI_API_KEY` are not passed through. Codex browser mode rejects API-key credential files, Claude copies only `claudeAiOauth`, and Grok copies only OIDC auth entries. User/project custom model configurations are not copied.

This controls the **authentication route**, not your provider's billing dashboard. Reviews consume the allowance/credits of the authenticated account. If your provider account enables paid extra usage, the CLI may consume it under that account's settings; this worker cannot enforce that external billing policy. Disable paid overage in the provider account if you require a strict subscription-only spending ceiling. CLI USD cost estimates in reports are not proof of an API bill or actual charges.

Missing/expired credentials, usage errors, unsupported protocol versions, and provider timeouts do not switch to API auth. A failed/timed-out provider is conservatively paused across PRs. Completed peers remain in a clearly partial report, which the example policy permits publishing. A report with no successful provider cannot publish; a partial zero-finding report is inconclusive.

After checking account usage and renewing the affected official CLI login:

```sh
npm run worker -- OWNER/REPO --pr 123 --once --resume-providers --retry-failed
```

`--resume-providers` clears pauses for this repository's worker. `--retry-failed` permits retrying unfinished current revisions. A successfully saved report is reused for publication recovery; the worker does not replace it with another review. A completed partial publication is not silently rerun on provider resume; the resumed provider participates in a later revision, or you can use an explicit local `review` command. Authentication copies are isolated per run and are not written back into your global CLI credential cache. Refresh rotation/expiry can require a new official login; the worker pauses instead of changing auth routes.

## Detection and publication

Ready open PRs on same-repository branches targeting the default branch are eligible. Drafts, forks, closed PRs, and alternate bases are explicit skips. Detection uses paginated GitHub REST reads, not Actions event delivery, so bot-created PRs are visible regardless of whether their credentials emit another workflow event. GitHub access still requires your local user token; the worker does not contact an author's coding session.

The revision identity includes repository/PR, head/base SHA, bounded PR intent, review configuration, publication policy, and tool version. Repeated polls and restarts reuse durable results. Metadata/policy changes can require a new review even without a new head. A bare Git fetch captures exact source as data; PR packages, scripts, hooks, filters, and tests are never executed.

`maxActivePrs` defaults to 1 and reviewer concurrency to 2. New revisions, draft conversion, or PR closure cancel an active review on the next successful poll. Publication is a separate phase and is never cancelled by that poll: the existing publisher rechecks freshness, validates evidence/source, serializes writes, journals intent, and reconciles remote ownership/markers. It posts COMMENT reviews only and never authorizes fixes, resolves discussions, approves, requests changes, or merges. Author assessment and human decisions remain M5.

## State and recovery

Private local state lives under `.pr-review/worker/<repository-hash>/`: job records, reports, pause state, and existing publication journals. A known report path is recorded before any model call. If the process dies before saving a report, restart marks that job interrupted and requires an explicit retry; it does not blindly spend more allowance. If publication failed, retry reuses the original report, snapshot, and policy. A changed config cannot bypass an unresolved publication for the same head/base; recover with the original configuration first. When recovering a pre-upgrade job, use the original coordinator version/config or inspect and reconcile its report with the local `publish` command before continuing.

Publication-attempt state is retained across recovery previews. A dry run checks source and prepares payloads; it does not reconcile an unknown write or clear a blocked publication. Retry the same saved report without `--preview` for actual reconciliation before changing its configuration.

A worker lock excludes a second process sharing this state root. A stale worker/publisher lock stops recovery; check the recorded PID and verify no worker or publisher is active before removing that exact lock. Use the same state directory for all local runs of this repository. Independent machines or separate directories are not covered by this lock.

No automatic retention cleanup runs locally. Keep pending reports/journals until resolved; losing state can lose model-call deduplication and uncertainty protection. Reports contain private source. An abrupt process kill may leave temporary credential copies in provider homes; do not upload the whole state tree. Model/poll failures are logged with controlled diagnostics. GitHub rate-limit/listing failures start no new jobs from that listing; continuous mode tries again at the poll interval while existing reviews remain bounded by their deadlines.

One-shot exit codes: `0` completed/published/previewed or no eligible job in this poll; `1` unfinished/blocked/failed; `2` completed with one or more providers paused; `130` operator cancellation. Findings and model limitations are visible in the retained report, rather than treated as a clean-review flag.
