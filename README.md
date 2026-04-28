# OysterWorkflow Core

OysterWorkflow Core turns Screenpipe activity traces into reusable OpenClaw skills.

This repository contains the core command-line pipeline only:

- Screenpipe capability probing and data ingest
- OCR, audio, and UI event normalization
- event dedupe and episode segmentation
- workflow discovery and LLM-backed skill extraction
- OpenClaw skill export helpers
- skill quality evaluation and regression helpers

It intentionally excludes the private desktop application, React UI, packaging scripts, notarization setup, release artifacts, bundled recorder binaries, and local run outputs.

## Requirements

- Node.js 20 or newer
- npm
- Screenpipe running locally when using live ingest commands
- an OpenAI-compatible API key when using LLM extraction

## Setup

```bash
npm install
```

Create `config/llm.local.json` for private local overrides, or set the environment variable referenced by `config/llm.config.json`.

## Common Commands

```bash
npm run typecheck
npm test
npm run dev -- ingest --from <ISO> --to <ISO> --apps "*" --out <abs-path> --base-url http://localhost:3030
npm run dev -- extract-skill-llm --run-dir <abs-path> --out <abs-path>
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

## License

This source is published under the PolyForm Noncommercial License 1.0.0. Commercial use requires a separate written license from the author.
