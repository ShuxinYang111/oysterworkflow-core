# Contributing

Thanks for taking a look at OysterWorkflow Core.

## Ground Rules

- Do not include real Screenpipe traces, screenshots, OCR text, API keys, or
  private run output in issues, tests, fixtures, or pull requests.
- Prefer small, focused changes with a clear reproduction or test.
- Keep output contracts stable unless the change explicitly updates the
  contract and tests.
- Use synthetic fixtures for ingest and extraction behavior.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Pull Requests

Good pull requests usually include:

- a short problem statement
- the implementation approach
- tests or a reason tests are not applicable
- notes about output contract or privacy impact

For promptset changes, add a new promptset version instead of rewriting an
existing one. The public repository currently keeps only the latest maintained
promptset, so public prompt changes should update the active promptset only when
that is the intended release.
