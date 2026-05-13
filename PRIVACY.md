# Privacy

OysterWorkflow Core processes local activity traces. Those traces may include
screen text, typed input, URLs, document content, account identifiers, internal
business data, credentials, personal information, and model prompts.

## Do Not Commit

Never commit real user data or local run output, including:

- `.runs/`
- raw `ui_events.ndjson`
- raw `ocr.ndjson`
- raw audio-derived data
- `llm-trace/`
- generated `assets.json`
- screenshots or screen recordings from real workflows
- `.env` or `config/llm.local.json`
- API keys, bearer tokens, passwords, cookies, or session identifiers

## Safe Examples

Use synthetic fixtures whenever possible. If a reproduction requires a trace,
create a minimal synthetic case that preserves event shape without preserving
private content.

## Issues And Pull Requests

Before posting logs, prompts, generated skills, or stack traces, check for
private data. Replace sensitive values with short placeholders such as
`<account-id>`, `<internal-url>`, or `<api-key>`.
