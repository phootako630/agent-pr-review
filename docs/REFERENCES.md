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

These sources establish integration primitives. The cross-review algorithm, deadlines, publication criteria, and milestones are design choices for this project, not vendor guarantees.
