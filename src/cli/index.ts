#!/usr/bin/env node
import { Command } from "commander";
import { parseCaseLoopCliArgs, runCaseLoop } from "./commands/case-loop.js";
import {
  parseDiscoverWorkflowsCliArgs,
  runDiscoverWorkflows,
} from "./commands/discover-workflows.js";
import {
  parseExtractSkillCliArgs,
  runExtractSkill,
} from "./commands/extract-skill.js";
import {
  parseE2eAnalyzeCliArgs,
  runE2eAnalyze,
} from "./commands/e2e-analyze.js";
import {
  parseExtractSkillLlmCliArgs,
  runExtractSkillLlm,
} from "./commands/extract-skill-llm.js";
import {
  parseReplayLlmCallCliArgs,
  runReplayLlmCall,
} from "./commands/replay-llm-call.js";
import { parseIngestCliArgs, runIngest } from "./commands/ingest.js";
import {
  parseOpenClawSkillInstallCliArgs,
  parseOpenClawSkillUninstallCliArgs,
  runOpenClawSkillInstall,
  runOpenClawSkillUninstall,
} from "./commands/openclaw-skill.js";
// EN: Unified CLI entrypoint for oysterworkflow.
const program = new Command();
program
  .name("oysterworkflow-core")
  .description("Screenpipe ingest pipeline for OpenClaw skill generation");

program
  .command("ingest")
  .description(
    "Fetch OCR + audio + UI events, normalize, segment episodes, and write ingest artifacts",
  )
  .requiredOption("--from <ISO>", "Start timestamp (ISO 8601)")
  .requiredOption("--to <ISO>", "End timestamp (ISO 8601)")
  .requiredOption(
    "--apps <csv|*>",
    "Application filter: '*' or comma-separated app names",
  )
  .requiredOption("--out <abs-path>", "Absolute output directory")
  .option("--base-url <url>", "Screenpipe base URL", "http://localhost:3030")
  .action(async (opts) => {
    try {
      // CN/EN: Parse and validate CLI strings into typed ingest options.
      const parsed = parseIngestCliArgs({
        from: String(opts.from),
        to: String(opts.to),
        apps: String(opts.apps),
        out: String(opts.out),
        baseUrl: String(opts.baseUrl),
      });

      const result = await runIngest(parsed);
      // CN/EN: Keep stdout machine-readable JSON for shell automation.
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.summary.runId,
            status: result.manifest.status,
            outputRunDir: result.manifest.paths.runDir,
            summaryPath: result.manifest.paths.summary,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      // CN/EN: Human-readable error goes to stderr; non-zero exit indicates failure.
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ingest failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("case-loop")
  .description(
    "Run fixed 11:50-11:57 Screenpipe case, evaluate skill quality, update PRD when needed",
  )
  .requiredOption(
    "--out <abs-path>",
    "Absolute output root directory for ingest runs",
  )
  .option(
    "--apps <csv|*>",
    "Application filter: '*' or comma-separated app names",
    "*",
  )
  .option("--base-url <url>", "Screenpipe base URL", "http://localhost:3030")
  .option(
    "--date <YYYY-MM-DD>",
    "Local date for test case window (default: 2026-03-03)",
  )
  .option("--from-time <HH:mm:ss>", "Local start time (default: 11:50:00)")
  .option("--to-time <HH:mm:ss>", "Local end time (default: 11:57:00)")
  .option(
    "--min-score <n>",
    "Minimum acceptable quality score (1-100)",
    (value) => Number(value),
  )
  .option("--case-title <text>", "Case title shown in PRD")
  .option("--prd <abs-path>", "Absolute path to PRD.md (default: <cwd>/PRD.md)")
  .option(
    "--config <path>",
    "LLM config JSON path (default: prefer <repo>/config/llm.local.json, fallback to <repo>/config/llm.config.json)",
  )
  .option("--model <name>", "OpenAI-compatible model override")
  .option("--api-key <key>", "OpenAI-compatible API key override")
  .option("--llm-base-url <url>", "OpenAI-compatible API base URL override")
  .option("--wire-api <mode>", "Wire API mode: responses | chat-completions")
  .option("--reasoning-effort <level>", "Reasoning effort hint")
  .option("--skill-name <text>", "Override generated skill name")
  .action(async (opts) => {
    try {
      const parsed = parseCaseLoopCliArgs({
        out: String(opts.out),
        apps: opts.apps ? String(opts.apps) : undefined,
        baseUrl: opts.baseUrl ? String(opts.baseUrl) : undefined,
        date: opts.date ? String(opts.date) : undefined,
        fromTime: opts.fromTime ? String(opts.fromTime) : undefined,
        toTime: opts.toTime ? String(opts.toTime) : undefined,
        minScore: opts.minScore as number | undefined,
        caseTitle: opts.caseTitle ? String(opts.caseTitle) : undefined,
        prd: opts.prd ? String(opts.prd) : undefined,
        config: opts.config ? String(opts.config) : undefined,
        model: opts.model ? String(opts.model) : undefined,
        apiKey: opts.apiKey ? String(opts.apiKey) : undefined,
        llmBaseUrl: opts.llmBaseUrl ? String(opts.llmBaseUrl) : undefined,
        wireApi: opts.wireApi ? String(opts.wireApi) : undefined,
        reasoningEffort: opts.reasoningEffort
          ? String(opts.reasoningEffort)
          : undefined,
        skillName: opts.skillName ? String(opts.skillName) : undefined,
      });

      const result = await runCaseLoop(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.runId,
            runDir: result.runDir,
            fromIso: result.fromIso,
            toIso: result.toIso,
            score: result.score,
            threshold: result.threshold,
            verdict: result.verdict,
            qualityPath: result.qualityPath,
            prdPath: result.prdPath,
            prdUpdated: result.prdUpdated,
            skillPath: result.skillPath,
            summaryPath: result.summaryPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`case-loop failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("discover-workflows")
  .description(
    "Discover workflow candidates from one completed ingest run and persist workflow-discovery.json",
  )
  .requiredOption("--run-dir <abs-path>", "Absolute path to one run directory")
  .option(
    "--out <abs-path>",
    "Absolute output path for workflow-discovery.json (default: <run-dir>/workflow-discovery.json)",
  )
  .option("--episode-id <id>", "Explicit episode id to analyze")
  .option("--name <text>", "Optional preferred skill/workflow name hint")
  .option(
    "--config <path>",
    "LLM config JSON path (default: prefer <repo>/config/llm.local.json, fallback to <repo>/config/llm.config.json)",
  )
  .option(
    "--wire-api <mode>",
    "Wire API mode: responses | chat-completions (default from config)",
  )
  .option(
    "--reasoning-effort <level>",
    "Reasoning effort hint (default from config, e.g. xhigh)",
  )
  .option(
    "--model <name>",
    "OpenAI-compatible model override (default from config)",
  )
  .option(
    "--api-key <key>",
    "OpenAI-compatible API key override (default from config)",
  )
  .option(
    "--base-url <url>",
    "OpenAI-compatible API base URL override (default from config)",
  )
  .action(async (opts) => {
    try {
      const parsed = parseDiscoverWorkflowsCliArgs({
        runDir: String(opts.runDir),
        out: opts.out ? String(opts.out) : undefined,
        episodeId: opts.episodeId ? String(opts.episodeId) : undefined,
        name: opts.name ? String(opts.name) : undefined,
        config: opts.config ? String(opts.config) : undefined,
        wireApi: opts.wireApi ? String(opts.wireApi) : undefined,
        reasoningEffort: opts.reasoningEffort
          ? String(opts.reasoningEffort)
          : undefined,
        model: opts.model ? String(opts.model) : undefined,
        apiKey: opts.apiKey ? String(opts.apiKey) : undefined,
        baseUrl: opts.baseUrl ? String(opts.baseUrl) : undefined,
      });
      const result = await runDiscoverWorkflows(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.runId,
            episodeId: result.episode.id,
            workflowCount: result.workflowCandidates.length,
            discoveryPath: result.path,
            workflowCandidates: result.workflowCandidates,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`discover-workflows failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("extract-skill")
  .description(
    "Discover workflows, prompt for one selection when needed, then extract one OpenClaw skill",
  )
  .requiredOption("--run-dir <abs-path>", "Absolute path to one run directory")
  .option(
    "--out <abs-path>",
    "Absolute output directory (default: <run-dir>/openclaw-llm)",
  )
  .option(
    "--discovery-out <abs-path>",
    "Absolute output path for workflow-discovery.json (default: <run-dir>/workflow-discovery.json)",
  )
  .option("--episode-id <id>", "Explicit episode id to extract")
  .option("--name <text>", "Override generated skill name")
  .option(
    "--config <path>",
    "LLM config JSON path (default: prefer <repo>/config/llm.local.json, fallback to <repo>/config/llm.config.json)",
  )
  .option(
    "--wire-api <mode>",
    "Wire API mode: responses | chat-completions (default from config)",
  )
  .option(
    "--reasoning-effort <level>",
    "Reasoning effort hint (default from config, e.g. xhigh)",
  )
  .option(
    "--model <name>",
    "OpenAI-compatible model override (default from config)",
  )
  .option(
    "--api-key <key>",
    "OpenAI-compatible API key override (default from config)",
  )
  .option(
    "--base-url <url>",
    "OpenAI-compatible API base URL override (default from config)",
  )
  .action(async (opts) => {
    try {
      const parsed = parseExtractSkillCliArgs({
        runDir: String(opts.runDir),
        out: opts.out ? String(opts.out) : undefined,
        discoveryOut: opts.discoveryOut ? String(opts.discoveryOut) : undefined,
        episodeId: opts.episodeId ? String(opts.episodeId) : undefined,
        name: opts.name ? String(opts.name) : undefined,
        config: opts.config ? String(opts.config) : undefined,
        wireApi: opts.wireApi ? String(opts.wireApi) : undefined,
        reasoningEffort: opts.reasoningEffort
          ? String(opts.reasoningEffort)
          : undefined,
        model: opts.model ? String(opts.model) : undefined,
        apiKey: opts.apiKey ? String(opts.apiKey) : undefined,
        baseUrl: opts.baseUrl ? String(opts.baseUrl) : undefined,
      });
      const result = await runExtractSkill(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.extractResult.summary.runId,
            episodeId: result.extractResult.summary.episodeId,
            selectedWorkflowId: result.selectedWorkflow.workflowId,
            workflowCount: result.workflowCandidates.length,
            discoveryPath: result.discoveryPath,
            skillId: result.extractResult.summary.skillId,
            stepsCount: result.extractResult.summary.stepsCount,
            skillPath: result.extractResult.paths.skillPath,
            summaryPath: result.extractResult.paths.summaryPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`extract-skill failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("e2e-analyze")
  .description(
    "Replay fixed e2e cases and generate completeness + skill quality analysis",
  )
  .option(
    "--out <abs-path>",
    "Absolute output directory (default: .runs/e2e-analysis)",
  )
  .option(
    "--cases <path>",
    "Case catalog path (default: test/fixtures/e2e-cases/cases.json)",
  )
  .action(async (opts) => {
    try {
      const parsed = parseE2eAnalyzeCliArgs({
        out: opts.out ? String(opts.out) : undefined,
        cases: opts.cases ? String(opts.cases) : undefined,
      });

      const result = await runE2eAnalyze(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            reportPath: result.reportPath,
            markdownPath: result.markdownPath,
            casesTotal: result.report.overview.casesTotal,
            completenessPassCount: result.report.overview.completenessPassCount,
            qualityPassCount: result.report.overview.qualityPassCount,
            autonomousIdealPassCount:
              result.report.overview.autonomousIdealPassCount,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`e2e-analyze failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("extract-skill-llm")
  .description(
    "Extract one OpenClaw skill with LLM reasoning from a completed ingest run",
  )
  .requiredOption("--run-dir <abs-path>", "Absolute path to one run directory")
  .option(
    "--out <abs-path>",
    "Absolute output directory (default: <run-dir>/openclaw-llm)",
  )
  .option(
    "--config <path>",
    "LLM config JSON path (default: prefer <repo>/config/llm.local.json, fallback to <repo>/config/llm.config.json)",
  )
  .option("--episode-id <id>", "Explicit episode id to extract")
  .option("--workflow-id <id>", "Explicit workflow id to extract")
  .option("--name <text>", "Override generated skill name")
  .option(
    "--wire-api <mode>",
    "Wire API mode: responses | chat-completions (default from config)",
  )
  .option(
    "--reasoning-effort <level>",
    "Reasoning effort hint (default from config, e.g. xhigh)",
  )
  .option(
    "--model <name>",
    "OpenAI-compatible model override (default from config)",
  )
  .option(
    "--api-key <key>",
    "OpenAI-compatible API key override (default from config)",
  )
  .option(
    "--base-url <url>",
    "OpenAI-compatible API base URL override (default from config)",
  )
  .option(
    "--enable-generalization",
    "Enable optional generalization component after skill-extraction",
  )
  .option(
    "--disable-generalization",
    "Disable optional generalization component after skill-extraction",
  )
  .option(
    "--enable-planner-optimization",
    "Enable optional planner-optimization component after skill-extraction",
  )
  .option(
    "--disable-planner-optimization",
    "Disable optional planner-optimization component after skill-extraction",
  )
  .action(async (opts) => {
    try {
      // CN/EN: Parse CLI args into typed LLM extraction options.
      const enableGeneralization =
        opts.enableGeneralization === true
          ? true
          : opts.disableGeneralization === true
            ? false
            : undefined;
      const enablePlannerOptimization =
        opts.enablePlannerOptimization === true
          ? true
          : opts.disablePlannerOptimization === true
            ? false
            : undefined;
      const parsed = parseExtractSkillLlmCliArgs({
        runDir: String(opts.runDir),
        out: opts.out ? String(opts.out) : undefined,
        config: opts.config ? String(opts.config) : undefined,
        episodeId: opts.episodeId ? String(opts.episodeId) : undefined,
        workflowId: opts.workflowId ? String(opts.workflowId) : undefined,
        name: opts.name ? String(opts.name) : undefined,
        wireApi: opts.wireApi ? String(opts.wireApi) : undefined,
        reasoningEffort: opts.reasoningEffort
          ? String(opts.reasoningEffort)
          : undefined,
        model: opts.model ? String(opts.model) : undefined,
        apiKey: opts.apiKey ? String(opts.apiKey) : undefined,
        baseUrl: opts.baseUrl ? String(opts.baseUrl) : undefined,
        enableGeneralization,
        enablePlannerOptimization,
      });

      const result = await runExtractSkillLlm(parsed);
      // CN/EN: Return key ids and output files for script integration.
      process.stdout.write(
        `${JSON.stringify(
          {
            runId: result.summary.runId,
            episodeId: result.summary.episodeId,
            selectedWorkflowId: result.selectedWorkflow.workflowId,
            skillId: result.summary.skillId,
            stepsCount: result.summary.stepsCount,
            skillPath: result.paths.skillPath,
            summaryPath: result.paths.summaryPath,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`extract-skill-llm failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("replay-llm-call")
  .description(
    "Replay one specific LLM call (planner-optimization/scenario-prediction/scenario-generalization) against existing skill artifacts",
  )
  .requiredOption(
    "--call <name>",
    "Target call: planner-optimization | scenario-prediction | scenario-generalization",
  )
  .requiredOption(
    "--skill-path <abs-path>",
    "Absolute path to one existing skill.json",
  )
  .option(
    "--summary-path <abs-path>",
    "Absolute path to summary.json (default: sibling summary.json next to --skill-path)",
  )
  .option(
    "--workflow-path <abs-path>",
    "Absolute path to workflow-discovery.json or one workflow JSON override",
  )
  .option(
    "--predicted-scenarios-path <abs-path>",
    "Absolute path to predicted-scenarios.json override for scenario-generalization",
  )
  .option(
    "--scenario-path <abs-path>",
    "Absolute path to one scenario JSON or scenario array JSON for scenario-generalization",
  )
  .option(
    "--scenario-id <id>",
    "Scenario id to select for scenario-generalization (defaults to first scenario)",
  )
  .option(
    "--out <abs-path>",
    "Absolute output directory (default: <cwd>/.runs/llm-call-replay-...)",
  )
  .option(
    "--config <path>",
    "LLM config JSON path (default: prefer <repo>/config/llm.local.json, fallback to <repo>/config/llm.config.json)",
  )
  .option(
    "--wire-api <mode>",
    "Wire API mode: responses | chat-completions (default from config)",
  )
  .option(
    "--reasoning-effort <level>",
    "Reasoning effort hint (default from config, e.g. xhigh)",
  )
  .option(
    "--model <name>",
    "OpenAI-compatible model override (default from config)",
  )
  .option(
    "--api-key <key>",
    "OpenAI-compatible API key override (default from config)",
  )
  .option(
    "--base-url <url>",
    "OpenAI-compatible API base URL override (default from config)",
  )
  .action(async (opts) => {
    try {
      const parsed = parseReplayLlmCallCliArgs({
        call: String(opts.call),
        skillPath: String(opts.skillPath),
        summaryPath: opts.summaryPath ? String(opts.summaryPath) : undefined,
        workflowPath: opts.workflowPath ? String(opts.workflowPath) : undefined,
        predictedScenariosPath: opts.predictedScenariosPath
          ? String(opts.predictedScenariosPath)
          : undefined,
        scenarioPath: opts.scenarioPath ? String(opts.scenarioPath) : undefined,
        scenarioId: opts.scenarioId ? String(opts.scenarioId) : undefined,
        out: opts.out ? String(opts.out) : undefined,
        config: opts.config ? String(opts.config) : undefined,
        wireApi: opts.wireApi ? String(opts.wireApi) : undefined,
        reasoningEffort: opts.reasoningEffort
          ? String(opts.reasoningEffort)
          : undefined,
        model: opts.model ? String(opts.model) : undefined,
        apiKey: opts.apiKey ? String(opts.apiKey) : undefined,
        baseUrl: opts.baseUrl ? String(opts.baseUrl) : undefined,
      });
      const result = await runReplayLlmCall(parsed);
      process.stdout.write(
        `${JSON.stringify(
          {
            call: result.call,
            outDir: result.outDir,
            resultPath: result.resultPath,
            reportPath: result.reportPath,
            traceDir: result.traceDir,
            selectedWorkflowId: result.selectedWorkflow?.workflowId ?? null,
            scenarioId: result.scenario?.scenarioId ?? null,
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`replay-llm-call failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

const openClawSkillProgram = program
  .command("openclaw-skill")
  .description(
    "Install or uninstall generated skills as OpenClaw-discoverable directories",
  );

openClawSkillProgram
  .command("install")
  .description(
    "Install one generated skill.json as an OpenClaw skill directory and verify discovery",
  )
  .requiredOption("--skill-path <abs-path>", "Absolute path to one skill.json")
  .option(
    "--summary-path <abs-path>",
    "Absolute path to companion summary.json (default: sibling summary.json when present)",
  )
  .option(
    "--install-name <text>",
    "Override generated install name before normalization",
  )
  .option(
    "--install-root <abs-path>",
    "Absolute install root (default: ~/.agents/skills)",
  )
  .option(
    "--run",
    "Run a planning-only smoke test via `openclaw agent --local` after install",
  )
  .action(async (opts) => {
    try {
      const parsed = parseOpenClawSkillInstallCliArgs({
        skillPath: String(opts.skillPath),
        summaryPath: opts.summaryPath ? String(opts.summaryPath) : undefined,
        installName: opts.installName ? String(opts.installName) : undefined,
        installRoot: opts.installRoot ? String(opts.installRoot) : undefined,
        run: Boolean(opts.run),
      });
      const result = await runOpenClawSkillInstall(parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`openclaw-skill install failed: ${message}\n`);
      process.exitCode = 1;
    }
  });

openClawSkillProgram
  .command("uninstall")
  .description(
    "Uninstall one previously exported OpenClaw skill directory created by this tool",
  )
  .requiredOption("--name <install-name>", "Generated install name to remove")
  .option(
    "--install-root <abs-path>",
    "Absolute install root (default: ~/.agents/skills)",
  )
  .action(async (opts) => {
    try {
      const parsed = parseOpenClawSkillUninstallCliArgs({
        name: String(opts.name),
        installRoot: opts.installRoot ? String(opts.installRoot) : undefined,
      });
      const result = await runOpenClawSkillUninstall(parsed);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`openclaw-skill uninstall failed: ${message}\n`);
      process.exitCode = 1;
    }
  });
// EN: Async parse allows command actions to await I/O safely.
program.parseAsync(process.argv);
