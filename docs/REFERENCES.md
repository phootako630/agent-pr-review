# Official integration references

Checked during planning on 2026-10-12. Recheck installed CLI versions and supported flags during implementation; examples in README describe our intended CLI, not existing vendor commands.

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
