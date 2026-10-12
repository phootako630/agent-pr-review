# Official integration references

Checked during planning on 2026-10-12. Recheck installed CLI versions and supported flags during implementation; examples in README describe our intended CLI, not existing vendor commands.

M4 references checked 2026-10-12:

- [Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target): trusted workflow context; never build/execute PR code with secrets.
- [Triggering workflows, including GITHUB_TOKEN exceptions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow): explicit dispatch fallback; some PR events can require approval under current rules.
- [Commit statuses REST API](https://docs.github.com/en/rest/commits/statuses): durable publication reservation/receipt; separate statuses read/write permission.
- [Actions artifact upload](https://github.com/actions/upload-artifact), [download](https://github.com/actions/download-artifact): pinned v4 revisions and explicit retention/data selection.

| Area | Official source | Relevance |
| --- | --- | --- |
| Codex | [Non-interactive mode](https://developers.openai.com/codex/noninteractive) | Programmatic CLI execution and structured output |
| Claude Code | [Run programmatically](https://code.claude.com/docs/en/headless) | Headless execution and output handling |
| Grok | [Headless and scripting](https://docs.x.ai/build/cli/headless-scripting) | CLI automation and JSON output |
| GitHub | [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews) | Comment-only reviews bound to a commit |
| GitHub | [Review comments](https://docs.github.com/en/rest/pulls/comments) | Inline anchors, comment reads and updates |
| GitHub Actions | [Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use) | Workflow trust boundaries and credentials |
| GitHub Actions | [Workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request) | Ready/updated PR triggers and event delivery constraints |

These sources establish integration primitives. The cross-review algorithm, deadlines, publication criteria, and milestones are design choices for this project, not vendor guarantees.
# M2 native protocol references

- [Claude CLI reference](https://code.claude.com/docs/en/cli-reference): bare/safe/restricted modes, tool restrictions, JSON schema, session persistence.
- [Grok CLI reference](https://docs.x.ai/build/cli/reference): headless commands and browser login.
- [Grok settings reference](https://docs.x.ai/build/settings/reference): GROK_HOME, credential selection, compatibility discovery, permission rules.
- [Official Windows Grok installer](https://x.ai/cli/install.ps1): native release artifact and version discovery. Live integration inspected Grok 1.0.50 help for prompt-file, tools, and JSON-schema flags.

## M3 publication references

- [Create/list pull request reviews](https://docs.github.com/en/rest/pulls/reviews): explicit commit ID, COMMENT event, grouped inline comments, and remote review state.
- [List/update review comments](https://docs.github.com/en/rest/pulls/comments): publisher ownership, original commit/line, reply identity, and body updates.
- These API primitives do not provide a cross-machine publication lock. Local journals, source revalidation, conservative grouping, uncertain-outcome handling, and the default partial-report policy are project decisions.
