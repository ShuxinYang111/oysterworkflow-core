# PromptSet Changelog

## 2026-04-15

- `specific-v22`
  - Based on `specific-v21`, added one explicit workflow-discovery instruction that audio evidence often carries the user's guidance and task-critical logic, so workflow intent and boundaries should align with relevant audio over incidental UI/OCR noise.
  - Added one matching skill-extraction instruction so step planning prioritizes relevant audio guidance and key logic over incidental UI/OCR noise.
  - `config/user-skill.config.json` now defaults to `specific-v22` with a version tag that marks this audio-priority alignment tweak.

## 2026-04-09

- `specific-v21`
  - Based on `specific-v20`, expanded the planner optimization system prompt with explicit `whenToUse` writing instructions for future-facing scenarios, recurring workflow intent, stable constraint preservation, and avoidance of one-time trace retelling.
  - Kept the change isolated to planner-facing `whenToUse` guidance so troubleshooting can focus on retrieval and matching behavior.
  - `config/user-skill.config.json` now defaults to `specific-v21` with a version tag that marks this planner `whenToUse` guidance tweak.

- `specific-v20`
  - Based on `specific-v19`, added one explicit asset-output contract line requiring each asset to use `name` and `value`, with `value` replacing the previously ambiguous `content` wording.
  - Kept the rest of the promptset unchanged so asset troubleshooting stays isolated to one prompt delta.
  - `config/user-skill.config.json` now defaults to `specific-v20` with a version tag that marks this asset-schema alignment tweak.

## 2026-04-08

- `specific-v19`
  - Based on `specific-v18`, added one extra scenario-prediction guard sentence requiring each kept scenario to produce a meaningfully different generalized skill from both the current specific skill and every other kept scenario.
  - Kept the rest of the promptset unchanged so the troubleshooting surface stays narrow.
  - `config/user-skill.config.json` now defaults to `specific-v19` with a version tag that marks this minimal scenario-distinctness tweak.

## 2026-04-04

- `specific-v18`
  - Rebuilt the English promptset directly from `specific-v16` instead of lightly editing `specific-v17`, with the goal of preserving the original Chinese semantics more faithfully.
  - Restored the missing scenario-prediction and scenario-generalization intent, including the partial-logic-reuse wording, the rewrite heuristic table, and the explicit from-scratch execution assumption.
  - `config/user-skill.config.json` now defaults to `specific-v18` with a version tag that marks it as a faithful `specific-v16` English translation.

- `specific-v17`
  - Added a fully English promptset based on `specific-v16` so the active prompt path no longer depends on Chinese prompt text.
  - Kept the step + terminal extraction contract unchanged while translating workflow discovery, extraction, planner optimization, and scenario generalization instructions.
  - `config/user-skill.config.json` now defaults to `specific-v17` with an English-only prompt version tag.

## 2026-04-02

- `specific-v16`
  - Based on `specific-v15`, consolidated the previously separate `skill-extraction-finalize` stage into the explicit `skill-extraction-terminal` mode.
  - The terminal mode now requires the last round to complete the remaining steps and final fields together, and makes it explicit that `coveredThroughEventId` should advance to the end of the terminal chunk.
  - `config/user-skill.config.json` switched to `specific-v16` by default to match the new step + terminal protocol.

## 2026-04-02

- `specific-v15`
  - Based on `specific-v13`, added one more semantic rule for `coveredThroughEventId`: it refers to the last event seen and consumed in the round, not necessarily the last event written as a new step.
  - `config/user-skill.config.json` switched to `specific-v15` by default to reduce extra empty chunks caused by tail-end wrap-up events.

## 2026-04-01

- `specific-v13`
  - Based on `specific-v12`, renamed prompt stages to semantic names: `skillExtraction`, `plannerOptimization`, `scenarioPrediction`, and `scenarioGeneralization`.
  - Replaced the old `callB-step` / `callB-finalize` names with `skill-extraction-step` / `skill-extraction-finalize` so the prompt contract matches the new trace labels, callProfiles, and CLI names.
  - `config/user-skill.config.json` switched to `specific-v13` by default as the only actively maintained promptset at that time.

## 2026-03-30

- `specific-v12`
  - Based on `specific-v10`, tightened the `callD` input context so the model now receives only `skill.json`, without an extra workflow or extraction-summary digest.
  - Rewrote the `callD` prompt into a lighter scenario-prediction instruction and cleared `userPreamble` so concrete context can be appended directly.
  - Added default completion for scenario normalization in `callD`: if the model omits `title` or `generalizationGuidance`, the code now synthesizes a minimal usable fallback so `callE` does not fail immediately.

## 2026-03-28

- `specific-v10`
  - Based on `specific-v9`, strengthened the website-login workflow generalization rules in `callE` and added explicit environment normalization constraints.
  - Distinguished stable target domains from unstable local browser containers so generalized skills do not implicitly depend on the user's current Chrome tabs, profile, cookies, or active session.
  - Added a from-scratch execution constraint so generalized skills can start without existing context and explicitly describe controlled browser startup, entering the target site, logging in when needed, and locating the target object.

- `specific-v9`
  - Based on `specific-v8`, added two post-processing stages, `callD` and `callE`, for the path specific skill -> predicted reuse scenarios -> scenario-conditioned generalized skill.
  - `callD` now outputs 1 to 3 lightly structured scenario cards rather than relying on hard-coded generalization fields.
  - `callE` performs scenario-conditioned generalization, emphasizing action preservation, relative time, stable platforms and domains, and stable output containers versus temporary instances.

## 2026-03-26

- `specific-v8`
  - Based on `specific-v7`, tightened the workflow-discovery split rule so “is this still the same final outcome?” matters more than “did the user switch app or page?”.
  - Explicitly required workflow boundaries to start from the entry action needed to reproduce the task, avoiding dropped app-open, landing-page, and search-entry steps.
  - Strengthened the `callB-step` requirement to preserve major phases such as entry, core operations, and verification/closure rather than compressing the workflow into a high-level summary.

- `specific-v7`
  - Based on `specific-v6`, added an explicit `workflowDiscovery` stage that identifies and ranks multiple workflow candidates inside an episode.
  - Changed the `callB` input semantics from the old `callA.goal / callA.skillName` shape to `selectedWorkflow`, so step generation follows the chosen workflow directly.
  - Kept the dual role of `shortDescription` and `description`, while the planner-facing rewrite stage still edits only copy-oriented fields.

- `specific-v6`
  - Based on `specific-v5`, introduced the dual-description mechanism with `shortDescription`.
  - Required `callB-finalize` and `callC` to produce a short summary within 280 characters instead of truncating the full `description` for OpenClaw frontmatter.
  - Kept the full `description` for the `SKILL.md` body while making OpenClaw discovery consume a shorter, more stable summary.

## 2026-03-25

- `specific-v5`
  - Based on `specific-v4`, added the staged `callB` protocol description.
  - Explicitly separated `callB-step` and `callB-finalize` so step mode no longer keeps outputting a full skill JSON while omitting `coveredThroughEventId`.
  - Clarified that finalize-stage `assets` are only additive and should not overwrite assets already extracted in earlier chunks.
