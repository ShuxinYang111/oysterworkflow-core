# OysterWorkflow Core

OysterWorkflow Core turns local Screenpipe activity traces into reusable
OpenClaw skills.

It is the open core command-line pipeline for:

- probing Screenpipe capabilities
- ingesting OCR, audio, and UI events
- normalizing, deduplicating, and segmenting activity events
- discovering workflow candidates
- extracting OpenClaw skills with an OpenAI-compatible LLM
- exporting and evaluating generated skill artifacts

The private desktop application, React UI, packaging scripts, notarization
setup, release artifacts, bundled recorder binaries, and local run outputs are
intentionally not part of this repository.

## Privacy First

Screenpipe traces can contain sensitive text from the screen, typed input,
browser context, internal documents, credentials, and personal data. Do not
commit real `.runs/` folders, raw `ui_events.ndjson`, raw `ocr.ndjson`,
`llm-trace` folders, generated `assets.json`, screenshots, or private
configuration files.

See [PRIVACY.md](./PRIVACY.md) before sharing examples, issues, or pull
requests.

## Requirements

- Node.js 20 or newer
- npm
- Screenpipe running locally for live ingest commands
- an OpenAI-compatible API key for LLM-backed extraction

## Setup

```bash
npm install
cp .env.example .env
```

Set `OPENAI_API_KEY` in `.env`, or provide it through your shell environment.
Private local overrides can live in `config/llm.local.json`; that file is
ignored by Git.

## Common Commands

```bash
npm run typecheck
npm test
npm run build
```

Live ingest from a local Screenpipe instance:

```bash
npm run dev -- ingest \
  --from <ISO> \
  --to <ISO> \
  --apps "*" \
  --out <abs-path> \
  --base-url http://localhost:3030
```

LLM extraction from a completed ingest run:

```bash
npm run dev -- extract-skill-llm \
  --run-dir <abs-path> \
  --out <abs-path>
```

## Output Contracts

Ingest writes:

- `<out>/runs/<run_id>/manifest.json`
- `<out>/runs/<run_id>/raw/ui_events.ndjson`
- `<out>/runs/<run_id>/raw/ocr.ndjson`
- `<out>/runs/<run_id>/normalized/events.ndjson`
- `<out>/runs/<run_id>/episodes.json`
- `<out>/runs/<run_id>/summary.json`

LLM extraction writes:

- `<run_dir>/openclaw*/skill.json`
- `<run_dir>/openclaw*/assets.json`
- `<run_dir>/openclaw*/summary.json`

## Promptsets

The public repository includes only the current maintained promptset:
`specific-v22`. Historical prompt experiments are intentionally excluded from
the open repository to keep the public surface smaller and easier to audit.

The active configuration is:

```json
{
  "granularity": "specific",
  "promptSet": "specific-v22",
  "promptVersionTag": "specific-v22-2026-04-15-audio-priority-alignment"
}
```

## Repository Layout

```text
config/                 Runtime and promptset configuration
scripts/                Utility scripts
src/cli/                Command-line entrypoints
src/screenpipe/         Screenpipe client and capability probing
src/ingest/             Fetch, normalize, dedupe, and segment pipeline
src/skill/              LLM extraction and prompt registry
src/quality/            Skill quality and ideal-skill comparison helpers
src/types/              Shared contracts
test/                   Vitest coverage
```

## Contributing

Contributions are welcome, especially around reproducible bugs, fixture-backed
tests, Screenpipe compatibility, and output contract clarity. Please read
[CONTRIBUTING.md](./CONTRIBUTING.md) first.

## Security

Please do not open public issues containing private traces, API keys, OCR text,
or LLM prompts from real user activity. See [SECURITY.md](./SECURITY.md) for
responsible disclosure.

## License

Apache License 2.0. See [LICENSE](./LICENSE) and
[LICENSE-SUMMARY.md](./LICENSE-SUMMARY.md).
