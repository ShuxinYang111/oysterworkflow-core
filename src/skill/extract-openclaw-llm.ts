import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { Agent } from "undici";
import { fetch } from "undici";
import type { Response as UndiciResponse } from "undici";
import { z } from "zod";
import {
  extractChatCompletionResult,
  extractOutputTextFromResponsesHttp,
  type LlmUsageSnapshot,
  parseLooseJson,
  type ResponsesStreamTrace,
  type ResponsesStreamHooks,
} from "./extract-openclaw-llm-output.js";
import {
  buildScenarioGeneralizationPromptPayload,
  buildScenarioPredictionPromptPayload,
  runGeneralizationComponent,
} from "./generalization/index.js";
import {
  resolveWorkflowEventBounds,
  sliceEventsForWorkflow,
} from "./workflow-event-slice.js";
import {
  plannerOptimizationDraftSchema,
  runPlannerOptimization,
  type PlannerOptimizationDraft,
} from "./planner-optimization/index.js";
import { loadPromptSet, renderPromptTemplate } from "./prompt-registry.js";
import { DEFAULT_USER_SKILL_CONFIG } from "./user-skill-config.js";
import type { LoadedPromptSet } from "./prompt-registry.js";
import type { UserSkillConfig } from "./user-skill-config.js";
import type {
  Episode,
  EventType,
  LlmInvocationSummary,
  NormalizedEvent,
  OpenClawSkillAsset,
  OpenClawSkillField,
  OpenClawSkill,
  OpenClawSkillStep,
  PredictedReuseScenario,
  RunManifest,
  SkillExecutionMode,
  SkillExtractionSummary,
  SkillGeneralizationSummary,
  WorkflowCandidate,
} from "../types/contracts.js";
const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_REASONING_EFFORT = "xhigh";
const LLM_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_RESPONSE_READ_TIMEOUT_MS = 90_000;
const DEFAULT_RESPONSE_TIMEOUT_MODE: OpenClawLlmResponseTimeoutMode = "fixed";
const DEFAULT_SCENARIO_PREDICTION_RESPONSE_READ_TIMEOUT_MS = 180_000;
const DEFAULT_SCENARIO_GENERALIZATION_RESPONSE_READ_TIMEOUT_MS = 180_000;
const LLM_CONNECT_TIMEOUT_MS = 30_000;
const LLM_REQUEST_RETRY_DELAYS_MS = [800, 1_800];
const MISSING_FIELD_TEXT = "LLM did not generate this field successfully";
const MISSING_OPERATION_APP_FROM_LLM = "MissingOperationAppFromLLM";
const DEFAULT_PLANNER_OPTIMIZATION_REASONING_EFFORT = "medium";
const DEFAULT_SKILL_EXTRACTION_REASONING_EFFORT = "medium";
const LLM_TRACE_DIRNAME = "llm-trace";
const CALL_B_INPUT_TOKEN_SAFE_LIMIT = 50_000;
const CALL_B_ESTIMATED_INPUT_TOKEN_LIMIT =
  CALL_B_INPUT_TOKEN_SAFE_LIMIT - 3_000;
const CALL_B_OVERLAP_EVENT_COUNT = 8;
const CALL_B_FALLBACK_LOOKBACK = 12;
const CALL_B_TIME_GAP_MS = 10_000;
const CALL_B_TOKEN_ENCODING = "o200k_base";

const MAX_HINTS_PER_STEP = 4;
const MAX_ERROR_SUMMARY_LENGTH = 280;
const MAX_NORMALIZE_WARNINGS = 8;
const TRACE_LLM_INPUT_ENV = "TRACE_LLM_INPUT";
const TRACE_LLM_TIMING_ENV = "TRACE_LLM_TIMING";
const OPENAI_JS_CLIENT_VERSION = "6.26.0";
const CODEX_DESKTOP_PROFILE_USER_AGENT =
  "Codex Desktop/0.117.0 (Mac OS 26.3.1; arm64) dumb (codex-exec; 0.117.0)";
const CODEX_DESKTOP_PROFILE_ORIGINATOR = "Codex Desktop";

const LLM_HTTP_AGENT = new Agent({
  connect: {
    timeout: LLM_CONNECT_TIMEOUT_MS,
    family: 4,
  },
});
const EVENT_TYPES: EventType[] = [
  "click",
  "move",
  "scroll",
  "key",
  "text",
  "app_switch",
  "window_focus",
  "clipboard",
  "audio",
  "ocr",
];
const llmStepDraftSchema = z.object({
  instruction: z.string().min(1),
  intent: z.string().min(1),
  operationApp: z.string().min(1),
  hints: z.array(z.string()).optional(),
  contextEventId: z.string().min(1).optional(),
  contextEventType: z
    .enum(EVENT_TYPES as [EventType, ...EventType[]])
    .optional(),
  contextAppName: z.string().nullable().optional(),
  contextWindowName: z.string().nullable().optional(),
});

const llmFieldDraftSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  required: z.boolean().optional(),
});

const llmAssetValueSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
  z.record(z.string(), z.string().min(1)),
]);

const llmAssetDraftSchema = z.object({
  name: z.string().min(1),
  value: llmAssetValueSchema,
  notes: z.string().optional(),
});

const workflowCandidateDraftSchema = z.object({
  workflowId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  priority: z.coerce.number().int().positive().optional(),
  confidence: z.coerce.number().min(0).max(100).optional(),
  startEventId: z.string().min(1).optional(),
  endEventId: z.string().min(1).optional(),
  startFrameId: z.coerce.number().int().nonnegative().optional(),
  endFrameId: z.coerce.number().int().nonnegative().optional(),
  whyThisWorkflow: z.string().min(1).optional(),
});

const workflowDiscoveryDraftSchema = z.object({
  workflows: z.array(workflowCandidateDraftSchema).min(1).optional(),
});
const llmSkillDraftSchema = z.object({
  skillName: z.string().min(1).optional(),
  shortDescription: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  goal: z.string().min(1),
  whenToUse: z.array(z.string().min(1)).min(1),
  whenNotToUse: z.array(z.string().min(1)).optional(),
  inputs: z.array(llmFieldDraftSchema).optional(),
  outputs: z.array(llmFieldDraftSchema).optional(),
  prerequisites: z.array(z.string().min(1)).min(1),
  steps: z.array(llmStepDraftSchema).min(1).optional(),
  successCriteria: z.array(z.string().min(1)).min(1),
  failureModes: z.array(z.string().min(1)).optional(),
  fallback: z.array(z.string().min(1)).min(1),
  examples: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  assets: z.array(llmAssetDraftSchema).optional(),
});

const predictedReuseScenarioDraftSchema = z.object({
  scenarioId: z.string().min(1),
  nextUseHypothesis: z.string().min(1),
});

const generalizedSkillDraftSchema = z.object({
  skillName: z.string().min(1).optional(),
  shortDescription: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  goal: z.string().min(1).optional(),
  whenToUse: z.array(z.string().min(1)).optional(),
  whenNotToUse: z.array(z.string().min(1)).optional(),
  inputs: z.array(llmFieldDraftSchema).optional(),
  outputs: z.array(llmFieldDraftSchema).optional(),
  prerequisites: z.array(z.string().min(1)).optional(),
  steps: z.array(llmStepDraftSchema).optional(),
  successCriteria: z.array(z.string().min(1)).optional(),
  failureModes: z.array(z.string().min(1)).optional(),
  fallback: z.array(z.string().min(1)).optional(),
  examples: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
});

type LlmStepDraft = z.infer<typeof llmStepDraftSchema>;
type LlmSkillDraft = z.infer<typeof llmSkillDraftSchema>;
type PredictedReuseScenarioDraft = z.infer<
  typeof predictedReuseScenarioDraftSchema
>;
type GeneralizedSkillDraft = z.infer<typeof generalizedSkillDraftSchema>;
export type OpenAiWireApi = "responses" | "chat-completions";
const DEFAULT_WIRE_API: OpenAiWireApi = "responses";
export type OpenAiCompatibleClientProfile =
  | "default"
  | "openai-js"
  | "codex-desktop";
export type OpenClawLlmResponseTimeoutMode = "fixed" | "idle";

export interface OpenClawLlmCallProfile {
  reasoningEffort?: string;
  responseReadTimeoutMs?: number;
}

export interface OpenClawLlmCallProfiles {
  "workflow-discovery"?: OpenClawLlmCallProfile;
  "skill-extraction-step"?: OpenClawLlmCallProfile;
  "skill-extraction-terminal"?: OpenClawLlmCallProfile;
  "skill-extraction-finalize"?: OpenClawLlmCallProfile;
  "planner-optimization"?: OpenClawLlmCallProfile;
  "scenario-prediction"?: OpenClawLlmCallProfile;
  "scenario-generalization"?: OpenClawLlmCallProfile;
}

export interface ExtractOpenClawSkillLlmComponents {
  generalization?: {
    enabled?: boolean;
  };
  plannerOptimization?: {
    enabled?: boolean;
  };
}

interface MaterializedSkillStep extends OpenClawSkillStep {
  contextEventType: EventType;
  contextAppName: string | null;
  contextWindowName: string | null;
}

/**
 * EN: Configuration for the LLM-based extractor.
 */
export interface ExtractOpenClawSkillLlmOptions {
  // CN/EN: Absolute path to one ingest run directory.
  runDir: string;
  // CN/EN: Optional output directory for generated artifacts.
  outDir?: string;
  // CN/EN: Explicit episode id; auto-select when omitted.
  episodeId?: string;
  // CN/EN: Skill name override preferred over generated names.
  skillName?: string;
  // CN/EN: OpenAI model override.
  model?: string;
  // CN/EN: OpenAI API key override.
  apiKey?: string;
  // CN/EN: OpenAI-compatible base URL.
  baseUrl?: string;
  // CN/EN: OpenAI-compatible wire API mode (`responses` or `chat-completions`).
  wireApi?: OpenAiWireApi;
  // CN/EN: Reasoning effort hint passed to compatible providers (e.g. `xhigh`).
  reasoningEffort?: string;
  // CN/EN: Global fallback response-read timeout in milliseconds.
  responseReadTimeoutMs?: number;
  // CN/EN: Whether timeout is fixed or resets while streamed output keeps arriving.
  responseTimeoutMode?: OpenClawLlmResponseTimeoutMode;
  // CN/EN: Optional client fingerprint profile for compatible endpoints.
  clientProfile?: OpenAiCompatibleClientProfile;
  // CN/EN: Optional extra request headers merged into each LLM request.
  extraHeaders?: Record<string, string>;
  // CN/EN: Per-call overrides for reasoning effort and response-read timeout.
  callProfiles?: OpenClawLlmCallProfiles;
  // CN/EN: Optional component-level enable/disable flags for post-extraction stages.
  components?: ExtractOpenClawSkillLlmComponents;
  // CN/EN: Injectable clock for deterministic tests.
  now?: Date;
  // CN/EN: Optional injected client for tests/custom providers.
  llmClient?: OpenClawLlmClient;
  // CN/EN: User skill prompt config override.
  userSkillConfig?: UserSkillConfig;
  // CN/EN: Explicit selected workflow id.
  workflowId?: string;
  // CN/EN: Pre-resolved workflow candidates.
  workflowCandidates?: WorkflowCandidate[];
  // CN/EN: Explicit selected workflow object.
  selectedWorkflow?: WorkflowCandidate;
}

export interface DiscoverOpenClawWorkflowsOptions {
  runDir: string;
  episodeId?: string;
  outPath?: string;
  skillName?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: OpenAiWireApi;
  reasoningEffort?: string;
  responseReadTimeoutMs?: number;
  responseTimeoutMode?: OpenClawLlmResponseTimeoutMode;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
  callProfiles?: OpenClawLlmCallProfiles;
  now?: Date;
  llmClient?: OpenClawLlmClient;
  userSkillConfig?: UserSkillConfig;
}

export interface WorkflowDiscoveryArtifact {
  schemaVersion: "openclaw-workflow-discovery-v1";
  generatedAt: string;
  runId: string;
  episodeId: string;
  source: {
    runDir: string;
    startTs: string;
    endTs: string;
  };
  workflowCandidates: WorkflowCandidate[];
  llm?: LlmInvocationSummary;
  warnings: string[];
}

export interface DiscoverOpenClawWorkflowsResult {
  runId: string;
  episode: Episode;
  workflowCandidates: WorkflowCandidate[];
  artifact: WorkflowDiscoveryArtifact;
  path: string | null;
}

/**
 * EN: LLM extraction result (objects + artifact paths).
 */
export interface ExtractOpenClawSkillLlmResult {
  skill: OpenClawSkill;
  summary: SkillExtractionSummary;
  generalization?: SkillGeneralizationSummary;
  paths: {
    outDir: string;
    skillPath: string;
    summaryPath: string;
  };
  selectedWorkflow: WorkflowCandidate;
  workflowCandidates: WorkflowCandidate[];
}
// EN: Event view for call B with null fields removed and rawRef fully omitted.
interface StepsPromptEvent {
  id: string;
  source: NormalizedEvent["source"];
  tsIso: string;
  tsMs: number;
  eventType: EventType;
  appName?: string;
  windowName?: string;
  textContent?: string;
  x?: number;
  y?: number;
  keyCode?: number;
  modifiers?: number;
  browserUrl?: string;
  frameId?: number;
}
// EN: Raw operation-record view for call A, keeping only event fields without synthetic summary wrappers.
interface MetadataPromptEvent {
  id: string;
  tsIso: string;
  eventType: EventType;
  appName?: string;
  windowName?: string;
  textContent?: string;
  browserUrl?: string;
  x?: number;
  y?: number;
  keyCode?: number;
  modifiers?: number;
  frameId?: number;
}

/**
 * EN: Trajectory context passed into the LLM client.
 */
export interface GenerateSkillDraftInput {
  runId: string;
  episode: Episode;
  events: NormalizedEvent[];
  selectedWorkflow?: WorkflowCandidate | null;
  providedSkillName?: string;
}

export interface DiscoverWorkflowsInput {
  runId: string;
  episode: Episode;
  events: NormalizedEvent[];
  providedSkillName?: string;
}

export interface OptimizeSkillForPlannerInput {
  skill: OpenClawSkill;
}

export interface PredictReusableScenariosInput {
  skill: OpenClawSkill;
  summary: SkillExtractionSummary;
  selectedWorkflow: WorkflowCandidate;
}

export interface GeneralizeSkillForScenarioInput {
  skill: OpenClawSkill;
  summary: SkillExtractionSummary;
  selectedWorkflow: WorkflowCandidate;
  scenario: PredictedReuseScenario;
}

/**
 * EN: Pluggable LLM client contract.
 */
export interface OpenClawLlmClient {
  /**
   * EN: Discovers workflow candidates from the timeline via LLM.
   * @param input trajectory context and constraints.
   * @returns raw model draft (may not fully match schema).
   */
  discoverWorkflows?(input: DiscoverWorkflowsInput): Promise<unknown>;
  /**
   * EN: Generates skill draft from timeline via LLM.
   * @param input trajectory context and constraints.
   * @returns raw model draft (may not fully match schema).
   */
  generateSkillDraft(input: GenerateSkillDraftInput): Promise<unknown>;
  /**
   * EN: Rewrites planner-facing fields on top of an existing skill to improve adoption when context matches.
   * @param input current skill JSON.
   * @returns model-produced rewritten field object.
   */
  optimizeSkillForPlanner?(
    input: OptimizeSkillForPlannerInput,
  ): Promise<unknown>;
  /**
   * EN: Predicts the most likely next-use scenarios for the current specific skill.
   * @param input current specific skill, summary, and selected workflow.
   * @returns scenario cards array or wrapped object.
   */
  predictReusableScenarios?(
    input: PredictReusableScenariosInput,
  ): Promise<unknown>;
  /**
   * EN: Generalizes a specific skill draft into one reusable variant based on one scenario card.
   * @param input specific skill, summary, workflow, and scenario card.
   * @returns generalized skill draft.
   */
  generalizeSkillForScenario?(
    input: GeneralizeSkillForScenarioInput,
  ): Promise<unknown>;
  /**
   * returns metrics from the last LLM invocation.
   * @returns last invocation aggregate metrics.
   */
  getLastInvocationMetrics?(): LlmInvocationMetrics | null;
  /**
   * returns warnings accumulated during the last LLM invocation.
   * @returns warnings from the last invocation.
   */
  getLastInvocationWarnings?(): string[];
}

interface LlmTraceContext {
  runDir: string;
  label: string;
  now?: Date;
}

interface LlmTracePaths {
  traceId: string;
  traceDir: string;
  jsonPath: string;
  streamPath: string;
  eventsPath: string;
}

interface PromptMeta {
  promptSet: string;
  promptSchemaVersion: string;
  promptFilePath: string;
  promptVersionTag?: string;
}

interface WorkflowGuidance {
  workflowId?: string;
  skillName?: string;
  description?: string;
  goal?: string;
  priority?: number;
}

interface SkillExtractionStepChunkResult {
  steps: unknown[];
  assets?: unknown;
  coveredThroughEventId: string;
  coveredThroughTsMs?: number;
}

interface SkillExtractionFieldCompletionResult {
  shortDescription?: unknown;
  description?: unknown;
  whenToUse?: unknown;
  whenNotToUse?: unknown;
  inputs?: unknown;
  outputs?: unknown;
  prerequisites?: unknown;
  successCriteria?: unknown;
  failureModes?: unknown;
  fallback?: unknown;
  examples?: unknown;
  tags?: unknown;
  assets?: unknown;
}

interface SkillExtractionTerminalResult extends SkillExtractionFieldCompletionResult {
  steps: unknown[];
  coveredThroughEventId: string;
  coveredThroughTsMs?: number;
}

interface SkillExtractionAccumulatedState {
  steps: unknown[];
  assetChunks: Array<{
    chunkIndex: number;
    assets: unknown;
  }>;
}

interface LlmCallMetrics {
  label: string;
  wireApi: OpenAiWireApi;
  usage: LlmUsageSnapshot | null;
  totalReactionTimeMs: number | null;
}

interface LlmInvocationMetrics {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalReactionTimeMs: number;
}

interface RequestSkillDraftTextResult {
  text: string;
  metrics: LlmCallMetrics;
  tracePaths: LlmTracePaths | null;
}

interface ResolvedOpenClawLlmCallProfile {
  reasoningEffort?: string;
  responseReadTimeoutMs: number;
  responseTimeoutMode: OpenClawLlmResponseTimeoutMode;
}

interface ResolvedOpenClawLlmCallProfiles {
  workflowDiscovery: ResolvedOpenClawLlmCallProfile;
  skillExtractionStep: ResolvedOpenClawLlmCallProfile;
  skillExtractionTerminal: ResolvedOpenClawLlmCallProfile;
  plannerOptimization: ResolvedOpenClawLlmCallProfile;
  scenarioPrediction: ResolvedOpenClawLlmCallProfile;
  scenarioGeneralization: ResolvedOpenClawLlmCallProfile;
}

interface RequestSkillDraftTraceMeta {
  chunkIndex?: number;
  startEventId?: string;
  endEventId?: string;
  overlapStartEventId?: string;
  returnedCursorEventId?: string | null;
  usedFallbackBoundary?: boolean;
  usedFallbackCursor?: boolean;
  estimatedInputTokens?: number;
  mode?: "step" | "terminal";
}

async function prepareLlmTracePaths(
  context: LlmTraceContext,
): Promise<LlmTracePaths> {
  const traceDir = join(resolve(context.runDir), LLM_TRACE_DIRNAME);
  await mkdir(traceDir, { recursive: true });
  const now = context.now ?? new Date();
  const traceId = buildTraceId(context.label, now);
  return {
    traceId,
    traceDir,
    jsonPath: join(traceDir, traceId + ".json"),
    streamPath: join(traceDir, traceId + ".stream.txt"),
    eventsPath: join(traceDir, traceId + ".events.jsonl"),
  };
}

function buildTraceId(label: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[:.]/g, "")
    .replace("T", "_")
    .replace("Z", "Z");
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const nonce = Math.random().toString(36).slice(2, 6);
  return stamp + "-" + safeLabel + "-" + nonce;
}

async function loadRunExtractionContext(input: {
  runDir: string;
  episodeId?: string;
}): Promise<{
  runDir: string;
  runId: string;
  episode: Episode;
  allEvents: NormalizedEvent[];
}> {
  const runDir = resolve(input.runDir);
  if (!isAbsolute(runDir)) {
    throw new Error(
      `--run-dir must be an absolute path, received: ${input.runDir}`,
    );
  }

  const episodes = await loadEpisodes(runDir);
  const episode = pickEpisode(episodes, input.episodeId);
  const allEvents = [...episode.events].sort((a, b) => a.tsMs - b.tsMs);
  const runId = await loadRunId(runDir, episodes);

  return {
    runDir,
    runId,
    episode,
    allEvents,
  };
}

function buildFallbackWorkflowCandidate(input: {
  events: NormalizedEvent[];
  episode: Episode;
  providedSkillName?: string;
}): WorkflowCandidate {
  const firstEvent = input.events[0];
  const lastEvent = input.events[input.events.length - 1];
  const fallbackName = buildSkillName(
    input.providedSkillName,
    input.events,
    input.episode,
  );
  return {
    workflowId: "workflow-1",
    name: fallbackName,
    description:
      "Fallback to a single workflow covering the entire episode so skill generation can continue.",
    goal: fallbackName,
    priority: 1,
    startEventId: firstEvent?.id ?? "workflow-start",
    endEventId: lastEvent?.id ?? "workflow-end",
    startTs: firstEvent?.tsIso ?? input.episode.startTs,
    endTs: lastEvent?.tsIso ?? input.episode.endTs,
    eventCount: input.events.length,
    whyThisWorkflow:
      "workflow-discovery did not provide a usable candidate, so the full trace was used as a fallback.",
  };
}

function normalizeWorkflowDiscoveryDraft(input: {
  rawDraft: unknown;
  events: NormalizedEvent[];
  episode: Episode;
  providedSkillName?: string;
  warnings: string[];
}): WorkflowCandidate[] {
  const draftRecord = asRecord(unwrapDraftEnvelope(input.rawDraft));
  if (!draftRecord) {
    pushWarning(
      input.warnings,
      "workflow-discovery output is not a JSON object; fallback to one workflow.",
    );
    return [
      buildFallbackWorkflowCandidate({
        events: input.events,
        episode: input.episode,
        providedSkillName: input.providedSkillName,
      }),
    ];
  }

  const parsedEnvelope = workflowDiscoveryDraftSchema.safeParse(draftRecord);
  const rawCandidates = Array.isArray(draftRecord.workflows)
    ? draftRecord.workflows
    : Array.isArray(parsedEnvelope.data?.workflows)
      ? parsedEnvelope.data.workflows
      : [draftRecord];
  const normalized: WorkflowCandidate[] = [];

  for (let index = 0; index < rawCandidates.length; index += 1) {
    const candidateRecord = asRecord(rawCandidates[index]);
    if (!candidateRecord) {
      continue;
    }

    const name = normalizeText(
      pickStringByKeys(candidateRecord, ["name"]) ?? "",
    );
    const goal = normalizeText(
      pickStringByKeys(candidateRecord, ["goal"]) ?? "",
    );
    if (!name && !goal) {
      continue;
    }

    const description =
      normalizeText(pickStringByKeys(candidateRecord, ["description"]) ?? "") ||
      goal ||
      name;
    const priority = Math.max(
      1,
      Math.trunc(
        normalizeOptionalNumber(
          pickFirstDefined(candidateRecord, ["priority"]),
        ) ?? index + 1,
      ),
    );
    const workflowId =
      normalizeText(pickStringByKeys(candidateRecord, ["workflowId"]) ?? "") ||
      `workflow-${index + 1}`;
    const confidenceRaw = normalizeOptionalNumber(
      pickFirstDefined(candidateRecord, ["confidence"]),
    );
    const confidence =
      confidenceRaw === undefined
        ? undefined
        : confidenceRaw > 1
          ? Math.max(0, Math.min(1, confidenceRaw / 100))
          : Math.max(0, Math.min(1, confidenceRaw));
    const startBoundaryRef = normalizeWorkflowBoundaryRef(
      pickFirstDefined(candidateRecord, ["startEventId", "startFrameId"]),
    );
    const endBoundaryRef = normalizeWorkflowBoundaryRef(
      pickFirstDefined(candidateRecord, ["endEventId", "endFrameId"]),
    );
    const bounds = resolveWorkflowEventBounds(input.events, {
      startEventId: startBoundaryRef.eventId,
      endEventId: endBoundaryRef.eventId,
      startFrameId: startBoundaryRef.frameId,
      endFrameId: endBoundaryRef.frameId,
    });
    const workflowEvents =
      bounds.endIndex >= bounds.startIndex
        ? input.events.slice(bounds.startIndex, bounds.endIndex + 1)
        : [];
    if (workflowEvents.length === 0) {
      continue;
    }

    normalized.push({
      workflowId,
      name: name || goal,
      description,
      goal: goal || name,
      priority,
      ...(confidence === undefined ? {} : { confidence }),
      startEventId: workflowEvents[0].id,
      endEventId: workflowEvents[workflowEvents.length - 1].id,
      startTs: workflowEvents[0].tsIso,
      endTs: workflowEvents[workflowEvents.length - 1].tsIso,
      eventCount: workflowEvents.length,
      ...(normalizeText(
        pickStringByKeys(candidateRecord, ["whyThisWorkflow"]) ?? "",
      )
        ? {
            whyThisWorkflow: normalizeText(
              pickStringByKeys(candidateRecord, ["whyThisWorkflow"]) ?? "",
            ),
          }
        : {}),
    });
  }

  if (normalized.length === 0) {
    pushWarning(
      input.warnings,
      "workflow-discovery produced no usable candidates; fallback to one workflow.",
    );
    return [
      buildFallbackWorkflowCandidate({
        events: input.events,
        episode: input.episode,
        providedSkillName: input.providedSkillName,
      }),
    ];
  }

  return normalized.sort((left, right) => left.priority - right.priority);
}

function resolveSelectedWorkflowCandidate(input: {
  workflowCandidates: WorkflowCandidate[];
  workflowId?: string;
  selectedWorkflow?: WorkflowCandidate;
}): WorkflowCandidate {
  if (input.selectedWorkflow) {
    return input.selectedWorkflow;
  }

  if (input.workflowId) {
    const matched =
      input.workflowCandidates.find(
        (candidate) => candidate.workflowId === input.workflowId,
      ) ?? null;
    if (!matched) {
      throw new Error(`Workflow not found: ${input.workflowId}`);
    }
    return matched;
  }

  const topCandidate = input.workflowCandidates[0] ?? null;
  if (!topCandidate) {
    throw new Error("No workflow candidates available for skill extraction.");
  }
  return topCandidate;
}

function buildWorkflowGuidance(
  workflow: WorkflowCandidate | null | undefined,
  providedSkillName?: string,
): WorkflowGuidance | null {
  if (!workflow && !providedSkillName) {
    return null;
  }

  const skillName =
    normalizeText(providedSkillName ?? "") ||
    normalizeText(workflow?.name ?? "");
  const goal = normalizeText(workflow?.goal ?? "");
  const description = normalizeText(workflow?.description ?? "");
  const priority = workflow?.priority;

  return {
    ...(normalizeText(workflow?.workflowId ?? "")
      ? { workflowId: normalizeText(workflow?.workflowId ?? "") }
      : {}),
    ...(skillName ? { skillName } : {}),
    ...(goal ? { goal } : {}),
    ...(description ? { description } : {}),
    ...(priority === undefined ? {} : { priority }),
  };
}

function combineLlmInvocationMetrics(
  metrics: Array<LlmInvocationMetrics | null | undefined>,
): LlmInvocationMetrics | null {
  const filtered = metrics.filter(
    (value): value is LlmInvocationMetrics =>
      value !== null && value !== undefined,
  );
  if (filtered.length === 0) {
    return null;
  }

  return filtered.reduce<LlmInvocationMetrics>(
    (accumulator, current) => ({
      callCount: accumulator.callCount + current.callCount,
      inputTokens: accumulator.inputTokens + current.inputTokens,
      outputTokens: accumulator.outputTokens + current.outputTokens,
      totalTokens: accumulator.totalTokens + current.totalTokens,
      totalReactionTimeMs:
        accumulator.totalReactionTimeMs + current.totalReactionTimeMs,
    }),
    {
      callCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalReactionTimeMs: 0,
    },
  );
}

async function runDefaultWorkflowDiscovery(input: {
  runDir: string;
  traceRunDir: string;
  runId: string;
  episode: Episode;
  events: NormalizedEvent[];
  providedSkillName?: string;
  userSkillConfig?: UserSkillConfig;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  wireApi?: OpenAiWireApi;
  reasoningEffort?: string;
  responseReadTimeoutMs?: number;
  responseTimeoutMode?: OpenClawLlmResponseTimeoutMode;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
  callProfiles?: OpenClawLlmCallProfiles;
}): Promise<{
  rawDraft: unknown;
  llmMetrics: LlmInvocationMetrics | null;
}> {
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("API key is required for workflow-discovery.");
  }

  const wireApi = normalizeWireApi(input.wireApi);
  const baseUrl = normalizeApiBaseUrl(input.baseUrl ?? DEFAULT_BASE_URL);
  const model = input.model ?? DEFAULT_MODEL;
  const callProfiles = resolveOpenClawLlmCallProfiles({
    reasoningEffort: input.reasoningEffort,
    responseReadTimeoutMs: input.responseReadTimeoutMs,
    responseTimeoutMode: input.responseTimeoutMode,
    callProfiles: input.callProfiles,
  });
  const userSkillConfig = input.userSkillConfig ?? DEFAULT_USER_SKILL_CONFIG;
  const promptSet = await loadPromptSet(userSkillConfig.promptSet);
  const promptMeta = buildPromptMeta(promptSet, userSkillConfig);
  const metadataEvents = buildMetadataPromptEvents(input.events);
  const payload = buildPromptPayloadForMetadata({
    metadataEvents,
    providedSkillName: input.providedSkillName,
    promptSet,
    userSkillConfig,
  });
  const result = await requestSkillDraftText({
    wireApi,
    baseUrl,
    apiKey,
    model,
    reasoningEffort: callProfiles.workflowDiscovery.reasoningEffort,
    clientProfile: input.clientProfile,
    extraHeaders: input.extraHeaders,
    systemPrompt: payload.systemPrompt,
    userPrompt: payload.userPrompt,
    requestLabel: "workflow-discovery",
    responseReadTimeoutMs: callProfiles.workflowDiscovery.responseReadTimeoutMs,
    responseTimeoutMode: callProfiles.workflowDiscovery.responseTimeoutMode,
    promptMeta,
    trace: { runDir: input.traceRunDir, label: "workflow-discovery" },
  });

  return {
    rawDraft: parseLooseJson(result.text),
    llmMetrics: summarizeLlmInvocationMetrics([result.metrics]),
  };
}

export async function discoverOpenClawWorkflows(
  options: DiscoverOpenClawWorkflowsOptions,
): Promise<DiscoverOpenClawWorkflowsResult> {
  const context = await loadRunExtractionContext({
    runDir: options.runDir,
    episodeId: options.episodeId,
  });
  const generatedAt = (options.now ?? new Date()).toISOString();
  const warnings: string[] = [];
  const outPath = options.outPath
    ? resolve(options.outPath)
    : join(context.runDir, "workflow-discovery.json");
  if (!isAbsolute(outPath)) {
    throw new Error(
      `--out must be an absolute path, received: ${options.outPath}`,
    );
  }

  let rawDraft: unknown = null;
  let llmMetrics: LlmInvocationMetrics | null = null;
  if (options.llmClient?.discoverWorkflows) {
    rawDraft = await options.llmClient.discoverWorkflows({
      runId: context.runId,
      episode: context.episode,
      events: context.allEvents,
      providedSkillName: options.skillName,
    });
    warnings.push(...(options.llmClient.getLastInvocationWarnings?.() ?? []));
    llmMetrics = options.llmClient.getLastInvocationMetrics?.() ?? null;
  } else if (!options.llmClient) {
    const defaultResult = await runDefaultWorkflowDiscovery({
      runDir: context.runDir,
      traceRunDir: context.runDir,
      runId: context.runId,
      episode: context.episode,
      events: context.allEvents,
      providedSkillName: options.skillName,
      userSkillConfig: options.userSkillConfig,
      model: options.model,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      wireApi: options.wireApi,
      reasoningEffort: options.reasoningEffort,
      responseReadTimeoutMs: options.responseReadTimeoutMs,
      responseTimeoutMode: options.responseTimeoutMode,
      clientProfile: options.clientProfile,
      extraHeaders: options.extraHeaders,
      callProfiles: options.callProfiles,
    });
    rawDraft = defaultResult.rawDraft;
    llmMetrics = defaultResult.llmMetrics;
  }

  const workflowCandidates =
    rawDraft === null
      ? [
          buildFallbackWorkflowCandidate({
            events: context.allEvents,
            episode: context.episode,
            providedSkillName: options.skillName,
          }),
        ]
      : normalizeWorkflowDiscoveryDraft({
          rawDraft,
          events: context.allEvents,
          episode: context.episode,
          providedSkillName: options.skillName,
          warnings,
        });
  const artifact: WorkflowDiscoveryArtifact = {
    schemaVersion: "openclaw-workflow-discovery-v1",
    generatedAt,
    runId: context.runId,
    episodeId: context.episode.id,
    source: {
      runDir: context.runDir,
      startTs: context.episode.startTs,
      endTs: context.episode.endTs,
    },
    workflowCandidates,
    ...(llmMetrics ? { llm: llmMetrics } : {}),
    warnings,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeJson(outPath, artifact);

  return {
    runId: context.runId,
    episode: context.episode,
    workflowCandidates,
    artifact,
    path: outPath,
  };
}

/**
 * EN: LLM-dominant skill extraction flow (plan 3).
 * @param options extraction options (run, model, API, step caps, etc.).
 * @returns generated skill/summary and output paths.
 */
export async function extractOpenClawSkillLlm(
  options: ExtractOpenClawSkillLlmOptions,
): Promise<ExtractOpenClawSkillLlmResult> {
  const context = await loadRunExtractionContext({
    runDir: options.runDir,
    episodeId: options.episodeId,
  });
  const runDir = context.runDir;
  const outDir = options.outDir
    ? resolve(options.outDir)
    : join(runDir, "openclaw-llm");
  if (!isAbsolute(outDir)) {
    throw new Error(
      `--out must be an absolute path, received: ${options.outDir}`,
    );
  }

  const now = options.now ?? new Date();
  const generatedAt = now.toISOString();
  const warnings: string[] = [];
  const outputPromptSet =
    options.userSkillConfig?.promptSet ?? DEFAULT_USER_SKILL_CONFIG.promptSet;
  const runId = context.runId;
  const episode = context.episode;
  const allEvents = context.allEvents;

  const discoveryResult =
    options.workflowCandidates && options.workflowCandidates.length > 0
      ? null
      : options.selectedWorkflow
        ? null
        : await discoverOpenClawWorkflows({
            runDir,
            episodeId: episode.id,
            skillName: options.skillName,
            model: options.model,
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
            wireApi: options.wireApi,
            reasoningEffort: options.reasoningEffort,
            clientProfile: options.clientProfile,
            extraHeaders: options.extraHeaders,
            callProfiles: options.callProfiles,
            now,
            llmClient: options.llmClient,
            userSkillConfig: options.userSkillConfig,
          });
  const workflowCandidates =
    options.workflowCandidates && options.workflowCandidates.length > 0
      ? options.workflowCandidates
      : (discoveryResult?.workflowCandidates ??
        (options.selectedWorkflow ? [options.selectedWorkflow] : []));
  warnings.push(...(discoveryResult?.artifact.warnings ?? []));
  const selectedWorkflow = resolveSelectedWorkflowCandidate({
    workflowCandidates,
    workflowId: options.workflowId,
    selectedWorkflow: options.selectedWorkflow,
  });
  const events = sliceEventsForWorkflow(allEvents, selectedWorkflow);
  if (events.length === 0) {
    throw new Error(
      `Selected workflow produced no events: ${selectedWorkflow.workflowId}`,
    );
  }

  const llmClient = options.llmClient ?? createDefaultOpenAiClient(options);
  let draft: LlmSkillDraft;
  const extractionStageMetrics: Array<LlmInvocationMetrics | null> = [];
  try {
    const draftGenerationStartedAtMs = Date.now();
    const rawDraft = await llmClient.generateSkillDraft({
      runId,
      episode,
      events,
      selectedWorkflow,
      providedSkillName: options.skillName,
    });
    warnings.push(...(llmClient.getLastInvocationWarnings?.() ?? []));
    extractionStageMetrics.push(
      llmClient.getLastInvocationMetrics?.() ??
        buildFallbackLlmInvocationMetrics(
          Date.now() - draftGenerationStartedAtMs,
          1,
        ),
    );
    const normalized = normalizeLlmDraft(rawDraft, events);
    warnings.push(...normalized.warnings);
    draft = normalized.draft;
  } catch (error) {
    throw new Error(`LLM draft generation failed: ${summarizeLlmError(error)}`);
  }

  const draftSteps = draft.steps ?? [];
  const materializedSteps = materializeStepsFromDraft(
    draftSteps,
    events,
    warnings,
  );
  const resolvedSteps = materializedSteps;
  if (resolvedSteps.length === 0) {
    throw new Error("LLM produced no valid steps after step normalization.");
  }

  const baseGoal = resolveGoalText(draft.goal, warnings);
  const baseSkillName = buildSkillName(
    options.skillName ?? draft.skillName,
    events,
    episode,
  );
  const publicAutonomousSteps = stripMaterializedStepContext(resolvedSteps);
  const autonomousSkill = buildSkillVariantFromDraft({
    mode: "autonomous",
    baseSkillName,
    baseGoal,
    draft,
    steps: publicAutonomousSteps,
    events,
    runId,
    runDir,
    episode,
    generatedAt,
    promptSet: outputPromptSet,
  });
  const specificSkill = appendWarningsToSkillFallback(
    autonomousSkill,
    warnings,
  );
  const paths = {
    outDir,
    skillPath: join(outDir, "skill.json"),
    summaryPath: join(outDir, "summary.json"),
  };
  const baseExtractionLlmMetrics =
    combineLlmInvocationMetrics([
      discoveryResult?.artifact.llm ?? null,
      ...extractionStageMetrics,
    ]) ??
    buildFallbackLlmInvocationMetrics(
      0,
      1 + ((discoveryResult?.artifact.llm?.callCount ?? 0) > 0 ? 1 : 0),
    );
  const baseSummary: SkillExtractionSummary = {
    runId,
    episodeId: episode.id,
    skillId: specificSkill.skillId,
    generatedAt,
    sourceEvents: events.length,
    stepsCount: publicAutonomousSteps.length,
    workflowCandidates,
    selectedWorkflowId: selectedWorkflow.workflowId,
    selectedWorkflowPriority: selectedWorkflow.priority,
    llm: baseExtractionLlmMetrics,
    output: {
      outDir,
      skillPath: paths.skillPath,
      summaryPath: paths.summaryPath,
    },
    warnings,
  };
  const components = resolveOpenClawSkillComponents(options.components);
  let generalization: SkillGeneralizationSummary | undefined;
  if (components.generalization.enabled) {
    if (
      !llmClient.predictReusableScenarios ||
      !llmClient.generalizeSkillForScenario
    ) {
      pushWarning(
        warnings,
        "Generalization skipped: llm client does not implement scenario prediction/generalization.",
      );
    } else {
      const userSkillConfig =
        options.userSkillConfig ?? DEFAULT_USER_SKILL_CONFIG;
      const promptSet = await loadPromptSet(userSkillConfig.promptSet);
      const templateVars = buildPromptTemplateVars({
        promptSet,
        userSkillConfig,
        providedSkillName: specificSkill.skillName,
      });
      generalization = await runGeneralizationComponent({
        outDir,
        skill: specificSkill,
        summary: baseSummary,
        events,
        selectedWorkflow,
        promptSet,
        userSkillConfig,
        templateVars,
        now,
        executeScenarioPrediction: async (_payload) => {
          const scenarioPredictionStartedAtMs = Date.now();
          const rawResult = await llmClient.predictReusableScenarios?.({
            skill: specificSkill,
            summary: baseSummary,
            selectedWorkflow,
          });
          const metrics =
            llmClient.getLastInvocationMetrics?.() ??
            buildFallbackLlmInvocationMetrics(
              Date.now() - scenarioPredictionStartedAtMs,
              1,
            );
          return {
            rawResult,
            metrics,
            warnings: llmClient.getLastInvocationWarnings?.() ?? [],
          };
        },
        normalizeScenarios: (rawResult, componentWarnings) =>
          normalizePredictedReusableScenarios(rawResult, componentWarnings),
        executeScenarioGeneralization: async ({
          scenario,
          payload: _payload,
        }) => {
          const scenarioGeneralizationStartedAtMs = Date.now();
          const rawResult = await llmClient.generalizeSkillForScenario?.({
            skill: specificSkill,
            summary: baseSummary,
            selectedWorkflow,
            scenario,
          });
          const metrics =
            llmClient.getLastInvocationMetrics?.() ??
            buildFallbackLlmInvocationMetrics(
              Date.now() - scenarioGeneralizationStartedAtMs,
              1,
            );
          return {
            rawResult,
            metrics,
            warnings: llmClient.getLastInvocationWarnings?.() ?? [],
          };
        },
        materializeGeneralizedSkill: ({
          rawResult,
          scenario,
          generatedAt,
          warnings: scenarioWarnings,
          events: scenarioEvents,
          skill,
        }) => {
          const draft = normalizeGeneralizedSkillDraft({
            rawDraft: rawResult,
            events: scenarioEvents,
            warnings: scenarioWarnings,
          });
          return applyScenarioGeneralizationToSkill({
            skill,
            draft,
            events: scenarioEvents,
            scenario,
            generatedAt,
            warnings: scenarioWarnings,
          });
        },
        summarizeError: summarizeLlmError,
        sanitizeScenarioIdentifier,
      });
      for (const generalizationWarning of generalization.warnings) {
        pushWarning(warnings, generalizationWarning);
      }
    }
  } else {
    pushWarning(
      warnings,
      "Generalization skipped: component disabled by configuration.",
    );
  }
  let finalSkill = specificSkill;
  if (components.plannerOptimization.enabled) {
    if (!llmClient.optimizeSkillForPlanner) {
      pushWarning(
        warnings,
        "Planner optimization skipped: llm client does not implement planner optimization.",
      );
    } else {
      const plannerOptimizationStartedAtMs = Date.now();
      try {
        const rawPlannerDraft = await llmClient.optimizeSkillForPlanner({
          skill: specificSkill,
        });
        warnings.push(...(llmClient.getLastInvocationWarnings?.() ?? []));
        extractionStageMetrics.push(
          llmClient.getLastInvocationMetrics?.() ??
            buildFallbackLlmInvocationMetrics(
              Date.now() - plannerOptimizationStartedAtMs,
              1,
            ),
        );
        const plannerDraft = normalizePlannerOptimizationDraft(rawPlannerDraft);
        finalSkill = applyPlannerOptimizationToSkill({
          skill: specificSkill,
          draft: plannerDraft,
          runId,
          episodeId: episode.id,
          generatedAt,
        });
      } catch (error) {
        pushWarning(
          warnings,
          `Planner optimization skipped: ${summarizeLlmError(error)}`,
        );
      }
    }
  } else {
    pushWarning(
      warnings,
      "Planner optimization skipped: component disabled by configuration.",
    );
  }
  finalSkill = appendWarningsToSkillFallback(finalSkill, warnings);
  const llmMetrics =
    combineLlmInvocationMetrics([
      discoveryResult?.artifact.llm ?? null,
      ...extractionStageMetrics,
    ]) ?? baseExtractionLlmMetrics;
  const summary: SkillExtractionSummary = {
    ...baseSummary,
    skillId: finalSkill.skillId,
    llm: llmMetrics,
    ...(generalization ? { generalization } : {}),
  };

  await mkdir(outDir, { recursive: true });
  await writeJson(paths.skillPath, finalSkill);
  await writeJson(paths.summaryPath, summary);

  return {
    skill: finalSkill,
    summary,
    ...(generalization ? { generalization } : {}),
    paths,
    selectedWorkflow,
    workflowCandidates,
  };
}

/**
 * EN: Creates default OpenAI-compatible client (switchable between Responses and Chat Completions).
 * @param options extraction options (apiKey/baseUrl/model/wireApi overrides).
 * @returns LLM client implementation.
 */
export function createDefaultOpenAiClient(
  options: ExtractOpenClawSkillLlmOptions,
): OpenClawLlmClient {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("API key is required for extract-skill-llm.");
  }

  const baseUrl = normalizeApiBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const model = options.model ?? DEFAULT_MODEL;
  const wireApi = normalizeWireApi(options.wireApi);
  const callProfiles = resolveOpenClawLlmCallProfiles({
    reasoningEffort: options.reasoningEffort,
    responseReadTimeoutMs: options.responseReadTimeoutMs,
    responseTimeoutMode: options.responseTimeoutMode,
    callProfiles: options.callProfiles,
  });
  const clientProfile = normalizeClientProfile(options.clientProfile);
  const extraHeaders = normalizeExtraHeaders(options.extraHeaders);
  const traceRunDir = resolve(options.runDir);
  let lastInvocationMetrics: LlmInvocationMetrics | null = null;
  let lastInvocationWarnings: string[] = [];
  let currentInvocationCalls: LlmCallMetrics[] = [];
  const resetInvocationState = () => {
    currentInvocationCalls = [];
    lastInvocationWarnings = [];
  };

  return {
    async generateSkillDraft(input: GenerateSkillDraftInput): Promise<unknown> {
      const userSkillConfig =
        options.userSkillConfig || DEFAULT_USER_SKILL_CONFIG;
      const promptSet = await loadPromptSet(userSkillConfig.promptSet);
      const promptMeta = buildPromptMeta(promptSet, userSkillConfig);
      resetInvocationState();
      const callAGuidance = buildWorkflowGuidance(
        input.selectedWorkflow,
        input.providedSkillName,
      );

      const skillExtractionState = await runSkillExtractionWorkflow({
        events: input.events,
        callAGuidance,
        promptSet,
        userSkillConfig,
        wireApi,
        baseUrl,
        apiKey,
        model,
        skillExtractionStepProfile: callProfiles.skillExtractionStep,
        skillExtractionTerminalProfile: callProfiles.skillExtractionTerminal,
        clientProfile,
        extraHeaders,
        promptMeta,
        traceRunDir,
        currentInvocationCalls,
        warnings: lastInvocationWarnings,
      });
      lastInvocationMetrics = summarizeLlmInvocationMetrics(
        currentInvocationCalls,
      );

      return assembleChunkedSkillExtractionDraft({
        workflowGuidance: callAGuidance,
        accumulatedSteps: skillExtractionState.accumulated.steps,
        terminalResult: skillExtractionState.terminalResult,
        accumulatedAssets: materializeAccumulatedChunkAssets(
          skillExtractionState.accumulated.assetChunks,
          lastInvocationWarnings,
        ),
        warnings: lastInvocationWarnings,
      });
    },
    async optimizeSkillForPlanner(
      input: OptimizeSkillForPlannerInput,
    ): Promise<unknown> {
      const userSkillConfig =
        options.userSkillConfig || DEFAULT_USER_SKILL_CONFIG;
      const promptSet = await loadPromptSet(userSkillConfig.promptSet);
      const promptMeta = buildPromptMeta(promptSet, userSkillConfig);
      resetInvocationState();
      return runPlannerOptimization({
        skill: input.skill,
        promptSet,
        templateVars: buildPromptTemplateVars({
          promptSet,
          userSkillConfig,
        }),
        execute: async ({ systemPrompt, userPrompt }) => {
          const plannerOptimizationResult = await requestSkillDraftText({
            wireApi,
            baseUrl,
            apiKey,
            model,
            reasoningEffort: callProfiles.plannerOptimization.reasoningEffort,
            clientProfile,
            extraHeaders,
            systemPrompt,
            userPrompt,
            requestLabel: "planner-optimization",
            responseReadTimeoutMs:
              callProfiles.plannerOptimization.responseReadTimeoutMs,
            responseTimeoutMode:
              callProfiles.plannerOptimization.responseTimeoutMode,
            promptMeta,
            trace: { runDir: traceRunDir, label: "planner-optimization" },
          });
          currentInvocationCalls.push(plannerOptimizationResult.metrics);
          lastInvocationMetrics = summarizeLlmInvocationMetrics(
            currentInvocationCalls,
          );
          return parseLooseJson(plannerOptimizationResult.text);
        },
      });
    },
    async predictReusableScenarios(
      input: PredictReusableScenariosInput,
    ): Promise<unknown> {
      const userSkillConfig =
        options.userSkillConfig || DEFAULT_USER_SKILL_CONFIG;
      const promptSet = await loadPromptSet(userSkillConfig.promptSet);
      const promptMeta = buildPromptMeta(promptSet, userSkillConfig);
      resetInvocationState();
      const payload = buildScenarioPredictionPromptPayload({
        skill: input.skill,
        promptSet,
        templateVars: buildPromptTemplateVars({
          promptSet,
          userSkillConfig,
          providedSkillName: input.skill.skillName,
        }),
      });
      const result = await requestSkillDraftText({
        wireApi,
        baseUrl,
        apiKey,
        model,
        reasoningEffort: callProfiles.scenarioPrediction.reasoningEffort,
        clientProfile,
        extraHeaders,
        systemPrompt: payload.systemPrompt,
        userPrompt: payload.userPrompt,
        requestLabel: "scenario-prediction",
        responseReadTimeoutMs:
          callProfiles.scenarioPrediction.responseReadTimeoutMs,
        responseTimeoutMode:
          callProfiles.scenarioPrediction.responseTimeoutMode,
        promptMeta,
        trace: {
          runDir: traceRunDir,
          label: "scenario-prediction",
        },
      });
      currentInvocationCalls.push(result.metrics);
      lastInvocationMetrics = summarizeLlmInvocationMetrics(
        currentInvocationCalls,
      );
      return parseLooseJson(result.text);
    },
    async generalizeSkillForScenario(
      input: GeneralizeSkillForScenarioInput,
    ): Promise<unknown> {
      const userSkillConfig =
        options.userSkillConfig || DEFAULT_USER_SKILL_CONFIG;
      const promptSet = await loadPromptSet(userSkillConfig.promptSet);
      const promptMeta = buildPromptMeta(promptSet, userSkillConfig);
      resetInvocationState();
      const payload = buildScenarioGeneralizationPromptPayload({
        skill: input.skill,
        scenario: input.scenario,
        promptSet,
        templateVars: buildPromptTemplateVars({
          promptSet,
          userSkillConfig,
          providedSkillName: input.skill.skillName,
        }),
      });
      const result = await requestSkillDraftText({
        wireApi,
        baseUrl,
        apiKey,
        model,
        reasoningEffort: callProfiles.scenarioGeneralization.reasoningEffort,
        clientProfile,
        extraHeaders,
        systemPrompt: payload.systemPrompt,
        userPrompt: payload.userPrompt,
        requestLabel: "scenario-generalization",
        responseReadTimeoutMs:
          callProfiles.scenarioGeneralization.responseReadTimeoutMs,
        responseTimeoutMode:
          callProfiles.scenarioGeneralization.responseTimeoutMode,
        promptMeta,
        trace: {
          runDir: traceRunDir,
          label: `scenario-generalization-${sanitizeScenarioIdentifier(input.scenario.scenarioId)}`,
        },
      });
      currentInvocationCalls.push(result.metrics);
      lastInvocationMetrics = summarizeLlmInvocationMetrics(
        currentInvocationCalls,
      );
      return parseLooseJson(result.text);
    },
    getLastInvocationMetrics(): LlmInvocationMetrics | null {
      return lastInvocationMetrics;
    },
    getLastInvocationWarnings(): string[] {
      return [...lastInvocationWarnings];
    },
  };
}

/**
 * EN: Sends request according to wire API and extracts JSON text output.
 * @param input request inputs (endpoint/auth/prompts/model).
 * @returns model output text.
 */
async function requestSkillDraftText(input: {
  wireApi: OpenAiWireApi;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
  systemPrompt: string;
  userPrompt: string;
  requestLabel?: string;
  responseReadTimeoutMs?: number;
  responseTimeoutMode?: OpenClawLlmResponseTimeoutMode;
  trace?: LlmTraceContext;
  promptMeta?: PromptMeta;
  traceMeta?: RequestSkillDraftTraceMeta;
}): Promise<RequestSkillDraftTextResult> {
  const requestLabel = input.requestLabel ?? input.wireApi;
  const responseReadTimeoutMs =
    input.responseReadTimeoutMs ?? DEFAULT_RESPONSE_READ_TIMEOUT_MS;
  const responseTimeoutMode =
    input.responseTimeoutMode ?? DEFAULT_RESPONSE_TIMEOUT_MODE;
  const traceContext = input.trace;
  let tracePaths: LlmTracePaths | null = null;
  let streamWriter: ReturnType<typeof createWriteStream> | null = null;
  let eventsWriter: ReturnType<typeof createWriteStream> | null = null;
  let streamText = "";
  let streamEventsCount = 0;
  const promptStats = {
    systemChars: input.systemPrompt.length,
    userChars: input.userPrompt.length,
    totalChars: input.systemPrompt.length + input.userPrompt.length,
  };

  if (traceContext) {
    tracePaths = await prepareLlmTracePaths(traceContext);
    streamWriter = createWriteStream(tracePaths.streamPath, { flags: "w" });
    eventsWriter = createWriteStream(tracePaths.eventsPath, { flags: "w" });
  }

  const appendStreamText = (chunk: string): void => {
    streamText += chunk;
    if (streamWriter) {
      streamWriter.write(chunk);
    }
  };

  const appendStreamEvent = (event: unknown): void => {
    streamEventsCount += 1;
    if (eventsWriter) {
      eventsWriter.write(JSON.stringify(event) + "\n");
    }
  };

  if (input.wireApi === "responses") {
    const responsesBody = {
      model: input.model,
      stream: true,
      store: false,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: input.systemPrompt,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: input.userPrompt,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_object",
        },
      },
      ...(input.reasoningEffort
        ? { reasoning: { effort: input.reasoningEffort } }
        : {}),
    };

    logLlmRequestPayload(requestLabel, responsesBody);
    const requestStartedAtMs = Date.now();
    let response: UndiciResponse | null = null;
    let responseReceivedAtMs: number | null = null;
    const streamTrace: ResponsesStreamTrace = {
      firstByteAtMs: null,
      firstEventAtMs: null,
      lastEventAtMs: null,
      sawCompleted: false,
      sawError: false,
      usage: null,
    };
    let readStartedAtMs: number | null = null;
    let readFinishedAtMs: number | null = null;
    let readError: unknown = null;
    let outputText = "";
    let usage: LlmUsageSnapshot | null = null;

    const hooks: ResponsesStreamHooks | undefined = traceContext
      ? {
          onDelta: (delta) => {
            appendStreamText(delta);
          },
          onFinalText: (text) => {
            if (!streamText) {
              appendStreamText(text);
            }
          },
          onEvent: (event) => {
            appendStreamEvent(event);
          },
        }
      : undefined;

    try {
      response = await postJsonWithTimeout({
        url: input.baseUrl + "/responses",
        apiKey: input.apiKey,
        body: responsesBody,
        clientProfile: input.clientProfile,
        extraHeaders: input.extraHeaders,
      });
      responseReceivedAtMs = Date.now();
      readStartedAtMs = Date.now();
      const responseResult = await readResponseWithTimeout({
        label: "Responses API output",
        response,
        timeoutMs: responseReadTimeoutMs,
        timeoutMode: responseTimeoutMode,
        read: ({ notifyActivity }) =>
          extractOutputTextFromResponsesHttp(
            response as UndiciResponse,
            streamTrace,
            {
              ...hooks,
              onActivity: notifyActivity,
            },
          ),
      });
      outputText = responseResult.outputText;
      usage = responseResult.usage ?? streamTrace.usage;
      if (!outputText) {
        throw new Error(
          "OpenAI-compatible Responses API response has no output text.",
        );
      }
      readFinishedAtMs = Date.now();
      return {
        text: outputText,
        metrics: {
          label: traceContext ? traceContext.label : requestLabel,
          wireApi: input.wireApi,
          usage,
          totalReactionTimeMs: readFinishedAtMs - requestStartedAtMs,
        },
        tracePaths,
      };
    } catch (error) {
      readError = error;
      throw error;
    } finally {
      if (readFinishedAtMs === null) {
        readFinishedAtMs = Date.now();
      }
      if (outputText && !streamText) {
        appendStreamText(outputText);
      }
      if (streamWriter) {
        streamWriter.end();
      }
      if (eventsWriter) {
        eventsWriter.end();
      }

      logLlmTiming(requestLabel, {
        requestStartedAtMs,
        responseReceivedAtMs,
        readStartedAtMs,
        readFinishedAtMs,
        contentType: response
          ? (response.headers.get("content-type") ?? null)
          : null,
        headerLatencyMs:
          responseReceivedAtMs !== null
            ? responseReceivedAtMs - requestStartedAtMs
            : null,
        readLatencyMs:
          readStartedAtMs !== null && readFinishedAtMs !== null
            ? readFinishedAtMs - readStartedAtMs
            : null,
        totalLatencyMs:
          readFinishedAtMs !== null
            ? readFinishedAtMs - requestStartedAtMs
            : null,
        firstByteAtMs: streamTrace.firstByteAtMs,
        firstEventAtMs: streamTrace.firstEventAtMs,
        lastEventAtMs: streamTrace.lastEventAtMs,
        firstByteLatencyMs:
          readStartedAtMs !== null && streamTrace.firstByteAtMs !== null
            ? streamTrace.firstByteAtMs - readStartedAtMs
            : null,
        firstEventLatencyMs:
          readStartedAtMs !== null && streamTrace.firstEventAtMs !== null
            ? streamTrace.firstEventAtMs - readStartedAtMs
            : null,
        lastEventLatencyMs:
          readStartedAtMs !== null && streamTrace.lastEventAtMs !== null
            ? streamTrace.lastEventAtMs - readStartedAtMs
            : null,
        sawCompleted: streamTrace.sawCompleted,
        sawError: streamTrace.sawError,
        error: readError ? toErrorMessage(readError) : null,
      });

      const totalReactionTimeMs =
        readFinishedAtMs !== null
          ? readFinishedAtMs - requestStartedAtMs
          : null;

      if (tracePaths) {
        await writeJson(tracePaths.jsonPath, {
          schemaVersion: "oysterworkflow-llm-trace-v1",
          label: traceContext ? traceContext.label : requestLabel,
          wireApi: input.wireApi,
          promptMeta: input.promptMeta || null,
          meta: input.traceMeta ?? null,
          request: {
            url: input.baseUrl + "/responses",
            body: responsesBody,
            promptStats,
            responseReadTimeoutMs,
            responseTimeoutMode,
          },
          response: {
            status: response ? response.status : null,
            contentType: response
              ? (response.headers.get("content-type") ?? null)
              : null,
          },
          usage: usage ?? streamTrace.usage,
          timing: {
            requestStartedAtMs,
            responseReceivedAtMs,
            readStartedAtMs,
            readFinishedAtMs,
            firstByteAtMs: streamTrace.firstByteAtMs,
            firstEventAtMs: streamTrace.firstEventAtMs,
            lastEventAtMs: streamTrace.lastEventAtMs,
            sawCompleted: streamTrace.sawCompleted,
            sawError: streamTrace.sawError,
            totalReactionTimeMs,
          },
          output: {
            text: outputText || null,
            streamText: streamText || null,
            error: readError ? toErrorMessage(readError) : null,
          },
          streamEvents: {
            count: streamEventsCount,
            eventsPath: tracePaths.eventsPath,
          },
          paths: tracePaths,
        });
      }
    }
  }

  const chatBody = {
    model: input.model,
    messages: [
      {
        role: "system",
        content: input.systemPrompt,
      },
      {
        role: "user",
        content: input.userPrompt,
      },
    ],
    response_format: {
      type: "json_object",
    },
    ...(input.reasoningEffort
      ? { reasoning_effort: input.reasoningEffort }
      : {}),
  };

  logLlmRequestPayload(requestLabel, chatBody);
  const requestStartedAtMs = Date.now();
  let chatError: unknown = null;
  let outputText = "";
  let usage: LlmUsageSnapshot | null = null;
  let chatResponse: UndiciResponse | null = null;
  let responseReceivedAtMs: number | null = null;
  let readStartedAtMs: number | null = null;
  let readFinishedAtMs: number | null = null;
  try {
    const response = await postJsonWithTimeout({
      url: input.baseUrl + "/chat/completions",
      apiKey: input.apiKey,
      body: chatBody,
      clientProfile: input.clientProfile,
      extraHeaders: input.extraHeaders,
    });
    chatResponse = response;
    responseReceivedAtMs = Date.now();
    readStartedAtMs = Date.now();
    const json = await readResponseWithTimeout({
      label: "Chat Completions API output",
      response,
      timeoutMs: responseReadTimeoutMs,
      timeoutMode: responseTimeoutMode,
      read: () => response.json(),
    });
    readFinishedAtMs = Date.now();
    const chatResult = extractChatCompletionResult(json);
    outputText = chatResult.outputText;
    usage = chatResult.usage;
    if (!outputText) {
      throw new Error(
        "OpenAI-compatible Chat Completions response has no message content.",
      );
    }
    return {
      text: outputText,
      metrics: {
        label: traceContext ? traceContext.label : requestLabel,
        wireApi: input.wireApi,
        usage,
        totalReactionTimeMs:
          readFinishedAtMs !== null
            ? readFinishedAtMs - requestStartedAtMs
            : null,
      },
      tracePaths,
    };
  } catch (error) {
    chatError = error;
    throw error;
  } finally {
    if (readFinishedAtMs === null) {
      readFinishedAtMs = Date.now();
    }
    if (tracePaths) {
      if (outputText && !streamText) {
        appendStreamText(outputText);
      }
      if (streamWriter) {
        streamWriter.end();
      }
      if (eventsWriter) {
        eventsWriter.end();
      }
      await writeJson(tracePaths.jsonPath, {
        schemaVersion: "oysterworkflow-llm-trace-v1",
        label: traceContext ? traceContext.label : requestLabel,
        wireApi: input.wireApi,
        promptMeta: input.promptMeta || null,
        meta: input.traceMeta ?? null,
        request: {
          url: input.baseUrl + "/chat/completions",
          body: chatBody,
          promptStats,
          responseReadTimeoutMs,
          responseTimeoutMode,
        },
        response: {
          status: chatResponse ? chatResponse.status : null,
          contentType: chatResponse
            ? chatResponse.headers.get("content-type") || null
            : null,
        },
        usage,
        timing: {
          requestStartedAtMs,
          responseReceivedAtMs,
          readStartedAtMs,
          readFinishedAtMs,
          totalReactionTimeMs:
            readFinishedAtMs !== null
              ? readFinishedAtMs - requestStartedAtMs
              : null,
        },
        output: {
          text: outputText || null,
          streamText: streamText || null,
          error: chatError ? toErrorMessage(chatError) : null,
        },
        streamEvents: {
          count: streamEventsCount,
          eventsPath: tracePaths.eventsPath,
        },
        paths: tracePaths,
      });
    }
  }
}

function summarizeLlmInvocationMetrics(
  calls: LlmCallMetrics[],
): LlmInvocationMetrics {
  return {
    callCount: calls.length,
    inputTokens: calls.reduce(
      (sum, call) => sum + (call.usage?.inputTokens ?? 0),
      0,
    ),
    outputTokens: calls.reduce(
      (sum, call) => sum + (call.usage?.outputTokens ?? 0),
      0,
    ),
    totalTokens: calls.reduce(
      (sum, call) => sum + (call.usage?.totalTokens ?? 0),
      0,
    ),
    totalReactionTimeMs: calls.reduce(
      (sum, call) => sum + (call.totalReactionTimeMs ?? 0),
      0,
    ),
  };
}

function buildFallbackLlmInvocationMetrics(
  totalReactionTimeMs: number,
  callCount = 1,
): LlmInvocationMetrics {
  return {
    callCount,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalReactionTimeMs,
  };
}

/**
 * EN: Normalizes API base URL; auto-appends `/v1` when only host is provided.
 * @param rawBaseUrl raw base URL.
 * @returns normalized URL ready for endpoint paths.
 */
function normalizeApiBaseUrl(rawBaseUrl: string): string {
  const url = new URL(rawBaseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "") {
    url.pathname = "/v1";
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * EN: Normalizes wire API option.
 * @param wireApi input wire API.
 * @returns normalized wire API.
 */
function normalizeWireApi(wireApi: OpenAiWireApi | undefined): OpenAiWireApi {
  return wireApi === "chat-completions" ? "chat-completions" : DEFAULT_WIRE_API;
}

/**
 * EN: Normalizes request client profile; unknown values fall back to direct mode.
 * @param clientProfile requested client profile.
 * @returns effective client profile.
 */
function normalizeClientProfile(
  clientProfile: OpenAiCompatibleClientProfile | undefined,
): OpenAiCompatibleClientProfile {
  return clientProfile === "openai-js" ||
      clientProfile === "codex-desktop"
    ? clientProfile
    : "default";
}

/**
 * EN: Normalizes extra request headers and drops blank keys/values.
 * @param extraHeaders extra request headers.
 * @returns headers safe to merge.
 */
function normalizeExtraHeaders(
  extraHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!extraHeaders) {
    return undefined;
  }
  const entries = Object.entries(extraHeaders)
    .map(([key, value]) => [key.trim(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * EN: Maps Node.js platform names to OpenAI JS SDK style `X-Stainless-OS` values.
 * @param platform Node.js platform name.
 * @returns OpenAI JS compatible OS label.
 */
function resolveOpenAiJsOs(platform: string): string {
  switch (platform) {
    case "darwin":
      return "MacOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    case "freebsd":
      return "FreeBSD";
    case "openbsd":
      return "OpenBSD";
    default:
      return `Other:${platform}`;
  }
}

/**
 * EN: Maps Node.js architectures to OpenAI JS SDK style `X-Stainless-Arch` values.
 * @param arch Node.js architecture.
 * @returns OpenAI JS compatible arch label.
 */
function resolveOpenAiJsArch(arch: string): string {
  switch (arch) {
    case "ia32":
      return "x32";
    case "x64":
      return "x64";
    case "arm":
      return "arm";
    case "arm64":
      return "arm64";
    default:
      return `other:${arch}`;
  }
}

/**
 * EN: Builds OpenAI JS SDK style headers for gateways that allow only known client fingerprints.
 * @param retryCount current retry count (0 on first request).
 * @returns OpenAI JS style headers.
 */
function buildOpenAiJsProfileHeaders(
  retryCount: number,
): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": `OpenAI/JS ${OPENAI_JS_CLIENT_VERSION}`,
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": OPENAI_JS_CLIENT_VERSION,
    "X-Stainless-OS": resolveOpenAiJsOs(process.platform),
    "X-Stainless-Arch": resolveOpenAiJsArch(process.arch),
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": process.version,
    "X-Stainless-Retry-Count": String(Math.max(0, retryCount)),
  };
}

/**
 * EN: Builds a Codex Desktop-like header profile for gateways that whitelist Codex traffic.
 * @returns request headers that mimic the observed Codex Desktop header family.
 */
function buildCodexDesktopProfileHeaders(): Record<string, string> {
  const sessionId = randomUUID();
  const turnId = randomUUID();
  return {
    Accept: "text/event-stream",
    "User-Agent": CODEX_DESKTOP_PROFILE_USER_AGENT,
    Originator: CODEX_DESKTOP_PROFILE_ORIGINATOR,
    "X-Client-Request-Id": sessionId,
    session_id: sessionId,
    "X-Codex-Turn-Metadata": JSON.stringify({
      session_id: sessionId,
      turn_id: turnId,
      sandbox: "none",
    }),
  };
}

/**
 * EN: Builds the effective header set for LLM requests.
 * @param input auth, client profile and custom headers.
 * @returns request headers object.
 */
function buildLlmRequestHeaders(input: {
  apiKey: string;
  attempt: number;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const normalizedClientProfile = normalizeClientProfile(input.clientProfile);
  const profileHeaders =
    normalizedClientProfile === "openai-js"
      ? buildOpenAiJsProfileHeaders(input.attempt - 1)
      : normalizedClientProfile === "codex-desktop"
        ? buildCodexDesktopProfileHeaders()
        : {};

  return {
    ...profileHeaders,
    ...normalizeExtraHeaders(input.extraHeaders),
    Authorization: `Bearer ${input.apiKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * EN: Normalizes reasoning-effort string (trimmed; empty becomes undefined).
 * @param value input reasoning effort.
 * @returns normalized value.
 */
function normalizeReasoningEffort(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * EN: Normalizes response-read timeout; only positive integers are accepted, otherwise falls back.
 * @param value configured timeout value.
 * @param fallbackMs fallback timeout in milliseconds.
 * @returns usable timeout in milliseconds.
 */
function normalizeResponseReadTimeoutMs(
  value: number | undefined,
  fallbackMs: number,
): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  ) {
    return value;
  }
  return fallbackMs;
}

function normalizeResponseTimeoutMode(
  value: OpenClawLlmResponseTimeoutMode | undefined,
): OpenClawLlmResponseTimeoutMode {
  return value === "idle" ? "idle" : DEFAULT_RESPONSE_TIMEOUT_MODE;
}

/**
 * EN: Merges global reasoning and per-call overrides into effective LLM profiles for each stage.
 * @param input global config and per-call overrides.
 * @returns effective config for each call.
 */
function resolveOpenClawLlmCallProfiles(input: {
  reasoningEffort?: string;
  responseReadTimeoutMs?: number;
  responseTimeoutMode?: OpenClawLlmResponseTimeoutMode;
  callProfiles?: OpenClawLlmCallProfiles;
}): ResolvedOpenClawLlmCallProfiles {
  const defaultReasoningEffort = normalizeReasoningEffort(
    input.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const defaultResponseReadTimeoutMs = normalizeResponseReadTimeoutMs(
    input.responseReadTimeoutMs,
    DEFAULT_RESPONSE_READ_TIMEOUT_MS,
  );
  const responseTimeoutMode = normalizeResponseTimeoutMode(
    input.responseTimeoutMode,
  );

  return {
    workflowDiscovery: resolveOpenClawLlmCallProfile({
      override: input.callProfiles?.["workflow-discovery"],
      fallbackReasoningEffort: defaultReasoningEffort,
      fallbackResponseReadTimeoutMs: defaultResponseReadTimeoutMs,
      responseTimeoutMode,
    }),
    skillExtractionStep: resolveOpenClawLlmCallProfile({
      override: input.callProfiles?.["skill-extraction-step"],
      fallbackReasoningEffort: DEFAULT_SKILL_EXTRACTION_REASONING_EFFORT,
      fallbackResponseReadTimeoutMs: defaultResponseReadTimeoutMs,
      responseTimeoutMode,
    }),
    skillExtractionTerminal: resolveOpenClawLlmCallProfile({
      override:
        input.callProfiles?.["skill-extraction-terminal"] ??
        input.callProfiles?.["skill-extraction-finalize"],
      fallbackReasoningEffort: DEFAULT_SKILL_EXTRACTION_REASONING_EFFORT,
      fallbackResponseReadTimeoutMs: defaultResponseReadTimeoutMs,
      responseTimeoutMode,
    }),
    plannerOptimization: resolveOpenClawLlmCallProfile({
      override: input.callProfiles?.["planner-optimization"],
      fallbackReasoningEffort: DEFAULT_PLANNER_OPTIMIZATION_REASONING_EFFORT,
      fallbackResponseReadTimeoutMs: defaultResponseReadTimeoutMs,
      responseTimeoutMode,
    }),
    scenarioPrediction: resolveOpenClawLlmCallProfile({
      override: input.callProfiles?.["scenario-prediction"],
      fallbackReasoningEffort: defaultReasoningEffort,
      fallbackResponseReadTimeoutMs:
        DEFAULT_SCENARIO_PREDICTION_RESPONSE_READ_TIMEOUT_MS,
      responseTimeoutMode,
    }),
    scenarioGeneralization: resolveOpenClawLlmCallProfile({
      override: input.callProfiles?.["scenario-generalization"],
      fallbackReasoningEffort: defaultReasoningEffort,
      fallbackResponseReadTimeoutMs:
        DEFAULT_SCENARIO_GENERALIZATION_RESPONSE_READ_TIMEOUT_MS,
      responseTimeoutMode,
    }),
  };
}

function resolveOpenClawSkillComponents(
  components: ExtractOpenClawSkillLlmComponents | undefined,
): {
  generalization: { enabled: boolean };
  plannerOptimization: { enabled: boolean };
} {
  return {
    generalization: {
      enabled: components?.generalization?.enabled ?? true,
    },
    plannerOptimization: {
      enabled: components?.plannerOptimization?.enabled ?? true,
    },
  };
}

/**
 * EN: Resolves the effective execution config for one LLM call.
 * @param input overrides and fallbacks for a single call.
 * @returns normalized reasoning and timeout.
 */
function resolveOpenClawLlmCallProfile(input: {
  override?: OpenClawLlmCallProfile;
  fallbackReasoningEffort?: string;
  fallbackResponseReadTimeoutMs: number;
  responseTimeoutMode: OpenClawLlmResponseTimeoutMode;
}): ResolvedOpenClawLlmCallProfile {
  const reasoningEffort = normalizeReasoningEffort(
    input.override?.reasoningEffort ?? input.fallbackReasoningEffort,
  );
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    responseReadTimeoutMs: normalizeResponseReadTimeoutMs(
      input.override?.responseReadTimeoutMs,
      input.fallbackResponseReadTimeoutMs,
    ),
    responseTimeoutMode: input.responseTimeoutMode,
  };
}

/**
 * EN: Sends JSON POST request with timeout and diagnostic error reporting.
 * @param input request URL, auth and JSON body.
 * @returns HTTP response object.
 */
async function postJsonWithTimeout(input: {
  url: string;
  apiKey: string;
  body: unknown;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
}): Promise<UndiciResponse> {
  const maxAttempts = LLM_REQUEST_RETRY_DELAYS_MS.length + 1;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(input.url, {
        method: "POST",
        headers: buildLlmRequestHeaders({
          apiKey: input.apiKey,
          attempt,
          clientProfile: input.clientProfile,
          extraHeaders: input.extraHeaders,
        }),
        body: JSON.stringify(input.body),
        signal: controller.signal,
        dispatcher: LLM_HTTP_AGENT,
      });

      if (response.ok) {
        return response;
      }

      const body = await response.text().catch(() => "");
      const httpError = new Error(
        `OpenAI-compatible API error ${response.status} at ${input.url} (attempt ${attempt}/${maxAttempts}): ${body}`,
      );
      if (attempt < maxAttempts && response.status >= 500) {
        lastError = httpError;
        await sleep(LLM_REQUEST_RETRY_DELAYS_MS[attempt - 1] ?? 0);
        continue;
      }
      throw httpError;
    } catch (error) {
      const wrappedError = new Error(
        `LLM request failed at ${input.url} (attempt ${attempt}/${maxAttempts}): ${toErrorMessage(error)}`,
      );
      if (attempt < maxAttempts) {
        lastError = wrappedError;
        await sleep(LLM_REQUEST_RETRY_DELAYS_MS[attempt - 1] ?? 0);
        continue;
      }
      throw wrappedError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw (
    lastError ?? new Error(`LLM request failed at ${input.url}: unknown error`)
  );
}

/**
 * EN: Prints LLM request body when env flag is enabled (API key excluded).
 * @param label request label.
 * @param body request body.
 */
function logLlmRequestPayload(label: string, body: unknown): void {
  if (process.env[TRACE_LLM_INPUT_ENV] !== "1") {
    return;
  }

  try {
    const payload = JSON.stringify(body, null, 2);
    process.stderr.write(
      `\n[oysterworkflow.llm] request=${label}\n${payload}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `\n[oysterworkflow.llm] request=${label} (failed to stringify): ${toErrorMessage(error)}\n`,
    );
  }
}

/**
 * EN: Logs LLM streaming timing data when env flag is enabled.
 * @param label request label.
 * @param timing timing data.
 */
function logLlmTiming(label: string, timing: Record<string, unknown>): void {
  if (process.env[TRACE_LLM_TIMING_ENV] !== "1") {
    return;
  }

  try {
    const payload = JSON.stringify(timing);
    process.stderr.write(
      "\n[oysterworkflow.llm] timing=" + label + " " + payload + "\n",
    );
  } catch (error) {
    process.stderr.write(
      "\n[oysterworkflow.llm] timing=" +
        label +
        " (failed to stringify): " +
        toErrorMessage(error) +
        "\n",
    );
  }
}

async function readResponseWithTimeout<T>(input: {
  label: string;
  response: UndiciResponse;
  timeoutMs: number;
  timeoutMode: OpenClawLlmResponseTimeoutMode;
  read: (helpers: { notifyActivity: () => void }) => Promise<T>;
}): Promise<T> {
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let rejectTimeout: ((reason: Error) => void) | null = null;
  const scheduleTimeout = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timedOut = true;
      rejectTimeout?.(
        new Error(
          input.timeoutMode === "idle"
            ? `${input.label} stopped receiving output for ${input.timeoutMs}ms.`
            : `${input.label} read timed out after ${input.timeoutMs}ms.`,
        ),
      );
    }, input.timeoutMs);
  };
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    scheduleTimeout();
  });
  const notifyActivity = (): void => {
    if (input.timeoutMode === "idle") {
      scheduleTimeout();
    }
  };

  try {
    return await Promise.race([input.read({ notifyActivity }), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (timedOut) {
      try {
        await input.response.body?.cancel();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function buildPromptMeta(
  promptSet: LoadedPromptSet,
  userSkillConfig: UserSkillConfig,
): PromptMeta {
  return {
    promptSet: promptSet.promptSet,
    promptSchemaVersion: promptSet.schemaVersion,
    promptFilePath: promptSet.filePath,
    promptVersionTag: userSkillConfig.promptVersionTag,
  };
}

function buildPromptTemplateVars(input: {
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
  providedSkillName?: string;
}): Record<string, string> {
  const promptVersionTag =
    input.userSkillConfig.promptVersionTag || input.promptSet.promptSet;
  const skillNameLine = input.providedSkillName
    ? "User-provided skillName: " + input.providedSkillName
    : "No skillName was provided. You may name the skill yourself.";
  return {
    promptSet: input.promptSet.promptSet,
    granularity: input.userSkillConfig.granularity,
    promptVersionTag,
    skillNameLine,
  };
}

/**
 * EN: Builds prompt for call A (goal/prereqs/etc.).
 */
function buildPromptPayloadForMetadata(input: {
  metadataEvents: MetadataPromptEvent[];
  providedSkillName?: string;
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
}): { systemPrompt: string; userPrompt: string } {
  const vars = buildPromptTemplateVars({
    promptSet: input.promptSet,
    userSkillConfig: input.userSkillConfig,
    providedSkillName: input.providedSkillName,
  });
  const systemPrompt = renderPromptTemplate(
    input.promptSet.workflowDiscovery.system,
    vars,
  );
  const userPreamble = renderPromptTemplate(
    input.promptSet.workflowDiscovery.userPreamble,
    vars,
  );
  const userPrompt = [
    userPreamble,
    JSON.stringify(input.metadataEvents, null, 2),
  ].join("\n");

  return { systemPrompt, userPrompt };
}

/**
 * EN: Builds raw operation records for call A, keeping the full timeline while stripping unrelated noisy text.
 * @param events all events in the current episode.
 * @returns raw event array for call A.
 */
function buildMetadataPromptEvents(
  events: NormalizedEvent[],
): MetadataPromptEvent[] {
  return events.map((event) => {
    const appName = normalizeNullableText(event.appName);
    const windowName = normalizeNullableText(event.windowName);
    const textContent = normalizeNullableText(event.textContent);
    const browserUrl = normalizeNullableText(event.browserUrl);

    return {
      id: event.id,
      tsIso: event.tsIso,
      eventType: event.eventType,
      ...(appName ? { appName } : {}),
      ...(windowName ? { windowName } : {}),
      ...(textContent ? { textContent } : {}),
      ...(browserUrl ? { browserUrl } : {}),
      ...(event.x !== null ? { x: event.x } : {}),
      ...(event.y !== null ? { y: event.y } : {}),
      ...(event.keyCode !== null ? { keyCode: event.keyCode } : {}),
      ...(event.modifiers !== null ? { modifiers: event.modifiers } : {}),
      ...(event.frameId !== null ? { frameId: event.frameId } : {}),
    };
  });
}

function buildSkillExtractionPromptBase(input: {
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
}): { systemPrompt: string; userPreamble: string } {
  const vars = buildPromptTemplateVars({
    promptSet: input.promptSet,
    userSkillConfig: input.userSkillConfig,
  });
  return {
    systemPrompt: renderPromptTemplate(
      input.promptSet.skillExtraction.system,
      vars,
    ),
    userPreamble: renderPromptTemplate(
      input.promptSet.skillExtraction.userPreamble,
      vars,
    ),
  };
}

function buildAccumulatedSkillExtractionReference(
  accumulated: SkillExtractionAccumulatedState,
): Record<string, unknown> {
  return {
    steps: accumulated.steps,
    assets: accumulated.assetChunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      assets: chunk.assets,
    })),
  };
}

/**
 * EN: Builds prompt for chunked skill-extraction-step requests.
 */
function buildPromptPayloadForSkillExtractionSteps(input: {
  events: NormalizedEvent[];
  callAGuidance?: WorkflowGuidance | null;
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
  accumulated: SkillExtractionAccumulatedState;
  chunkIndex: number;
}): { systemPrompt: string; userPrompt: string } {
  const promptEvents = buildPromptEventsForSteps(input.events);
  const basePrompt = buildSkillExtractionPromptBase({
    promptSet: input.promptSet,
    userSkillConfig: input.userSkillConfig,
  });
  const userPrompt = [
    basePrompt.userPreamble,
    "Selected workflow guidance (from workflow-discovery, may be null):",
    JSON.stringify(input.callAGuidance ?? null, null, 2),
    "Accumulated steps/assets so far (continuation reference only; do not repeat already-covered steps):",
    JSON.stringify(
      buildAccumulatedSkillExtractionReference(input.accumulated),
      null,
      2,
    ),
    "Current mode: skill-extraction-step",
    `Current chunkIndex=${input.chunkIndex}`,
    "Requirements:",
    "- The accumulated steps/assets are only continuation references. Do not rewrite or reorder them.",
    "- If this window starts with a small overlap of events, those events are only for continuity and do not mean the steps must be rewritten.",
    "- Add only the uncovered subsequent steps. Do not repeat steps that have already been covered.",
    "- The output must be a single JSON object, and the only allowed fields are: steps, assets, coveredThroughEventId, coveredThroughTsMs.",
    "Raw event array:",
    JSON.stringify(promptEvents, null, 2),
  ].join("\n");

  return { systemPrompt: basePrompt.systemPrompt, userPrompt };
}

/**
 * EN: Builds prompt for skill-extraction-terminal, completing remaining steps and final fields together.
 */
function buildPromptPayloadForSkillExtractionTerminal(input: {
  events: NormalizedEvent[];
  callAGuidance?: WorkflowGuidance | null;
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
  accumulated: SkillExtractionAccumulatedState;
  chunkIndex: number;
  terminalChunkEndEventId?: string;
}): { systemPrompt: string; userPrompt: string } {
  const promptEvents = buildPromptEventsForSteps(input.events);
  const basePrompt = buildSkillExtractionPromptBase({
    promptSet: input.promptSet,
    userSkillConfig: input.userSkillConfig,
  });
  const userPrompt = [
    basePrompt.userPreamble,
    "Selected workflow guidance (from workflow-discovery, may be null):",
    JSON.stringify(input.callAGuidance ?? null, null, 2),
    "Accumulated steps/assets so far (continuation reference only; do not rewrite existing steps, but you may complete the final fields):",
    JSON.stringify(
      buildAccumulatedSkillExtractionReference(input.accumulated),
      null,
      2,
    ),
    "Current mode: skill-extraction-terminal",
    `Current chunkIndex=${input.chunkIndex}`,
    "Requirements:",
    "- This is the final round. You must consume all remaining events in this round and leave nothing for a later pass.",
    "- The accumulated steps/assets are only continuation references. Do not rewrite or reorder them.",
    "- If this window starts with a small overlap of events, those events are only for continuity and do not mean the steps must be rewritten.",
    "- This round must do two things at once: add the uncovered subsequent steps and complete the final fields.",
    `- The last event ID in the current terminal chunk is: ${input.terminalChunkEndEventId ?? "unknown"}. coveredThroughEventId must advance to that endpoint and must not leave remaining events behind.`,
    "- The output must be a single JSON object.",
    "- The only allowed fields are: steps, assets, coveredThroughEventId, coveredThroughTsMs, shortDescription, description, whenToUse, whenNotToUse, inputs, outputs, prerequisites, successCriteria, failureModes, fallback, examples, tags.",
    "Raw event array:",
    JSON.stringify(promptEvents, null, 2),
  ].join("\n");

  return { systemPrompt: basePrompt.systemPrompt, userPrompt };
}

let skillExtractionTokenEncoder: Tiktoken | null = null;

function getSkillExtractionTokenEncoder(): Tiktoken {
  if (skillExtractionTokenEncoder === null) {
    skillExtractionTokenEncoder = getEncoding(CALL_B_TOKEN_ENCODING);
  }
  return skillExtractionTokenEncoder;
}

function estimateInputTokens(systemPrompt: string, userPrompt: string): number {
  const encoder = getSkillExtractionTokenEncoder();
  return (
    encoder.encode(systemPrompt).length + encoder.encode(userPrompt).length
  );
}

function materializeAccumulatedChunkAssets(
  chunks: SkillExtractionAccumulatedState["assetChunks"],
  warnings: string[],
): OpenClawSkillAsset[] | undefined {
  const output: OpenClawSkillAsset[] = [];
  for (const chunk of chunks) {
    const normalized = normalizeOptionalSkillAssetList(chunk.assets, warnings);
    if (normalized) {
      output.push(...normalized);
    }
  }
  return output.length > 0 ? output : undefined;
}

function mergeChunkedSkillExtractionAssets(input: {
  accumulatedAssets?: OpenClawSkillAsset[];
  finalizeAssets: unknown;
  warnings: string[];
}): OpenClawSkillAsset[] | undefined {
  const finalizeAssets = normalizeOptionalSkillAssetList(
    input.finalizeAssets,
    input.warnings,
  );
  const merged = normalizeSkillAssets([
    ...(input.accumulatedAssets ?? []),
    ...(finalizeAssets ?? []),
  ]);
  return merged.length > 0 ? merged : undefined;
}

function assembleChunkedSkillExtractionDraft(input: {
  workflowGuidance?: WorkflowGuidance | null;
  accumulatedSteps: unknown[];
  terminalResult: SkillExtractionTerminalResult;
  accumulatedAssets?: OpenClawSkillAsset[];
  warnings: string[];
}): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const guidance = input.workflowGuidance ?? null;
  if (guidance?.skillName) {
    output.skillName = guidance.skillName;
  }
  if (guidance?.goal) {
    output.goal = guidance.goal;
  }

  const terminalEntries = Object.entries(input.terminalResult).filter(
    ([key, value]) =>
      value !== undefined &&
      key !== "goal" &&
      key !== "skillName" &&
      key !== "steps" &&
      key !== "coveredThroughEventId" &&
      key !== "coveredThroughTsMs",
  );
  for (const [key, value] of terminalEntries) {
    output[key] = value;
  }

  output.steps = input.accumulatedSteps;
  const mergedAssets =
    input.terminalResult.assets === undefined
      ? input.accumulatedAssets
      : mergeChunkedSkillExtractionAssets({
          accumulatedAssets: input.accumulatedAssets,
          finalizeAssets: input.terminalResult.assets,
          warnings: input.warnings,
        });
  if (mergedAssets) {
    output.assets = mergedAssets;
  }

  if (output.skillName === undefined && !guidance?.skillName) {
    const terminalRecord = asRecord(input.terminalResult as unknown);
    if (terminalRecord?.skillName !== undefined) {
      output.skillName = terminalRecord.skillName;
    }
  }
  if (output.goal === undefined && !guidance?.goal) {
    const terminalRecord = asRecord(input.terminalResult as unknown);
    if (terminalRecord?.goal !== undefined) {
      output.goal = terminalRecord.goal;
    }
  }

  return output;
}

function buildSkillExtractionChunkBudgetError(prefix: string): Error {
  return new Error(
    `${prefix}; estimated call B input exceeded ${CALL_B_ESTIMATED_INPUT_TOKEN_LIMIT} tokens (safe limit ${CALL_B_INPUT_TOKEN_SAFE_LIMIT}).`,
  );
}

function chooseFallbackChunkBoundary(
  events: NormalizedEvent[],
  requiredStartIndex: number,
  candidateEndIndex: number,
): { endIndex: number; usedFallbackBoundary: boolean } {
  const lookbackStart = Math.max(
    requiredStartIndex,
    candidateEndIndex - CALL_B_FALLBACK_LOOKBACK + 1,
  );
  for (let index = candidateEndIndex; index >= lookbackStart; index -= 1) {
    const event = events[index];
    if (
      event.eventType === "app_switch" ||
      event.eventType === "window_focus"
    ) {
      if (index < candidateEndIndex) {
        return { endIndex: index, usedFallbackBoundary: true };
      }
      return { endIndex: candidateEndIndex, usedFallbackBoundary: false };
    }
    const next = events[index + 1] ?? null;
    if (next && next.tsMs - event.tsMs >= CALL_B_TIME_GAP_MS) {
      if (index < candidateEndIndex) {
        return { endIndex: index, usedFallbackBoundary: true };
      }
      return { endIndex: candidateEndIndex, usedFallbackBoundary: false };
    }
  }

  return { endIndex: candidateEndIndex, usedFallbackBoundary: false };
}

function selectSkillExtractionChunkForBudget(input: {
  events: NormalizedEvent[];
  cursorIndex: number;
  callAGuidance?: WorkflowGuidance | null;
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
  accumulated: SkillExtractionAccumulatedState;
  chunkIndex: number;
}): {
  payload: { systemPrompt: string; userPrompt: string };
  chunkEvents: NormalizedEvent[];
  startIndex: number;
  endIndex: number;
  overlapStartIndex: number;
  estimatedInputTokens: number;
  usedFallbackBoundary: boolean;
  isTerminalChunk: boolean;
} {
  if (input.cursorIndex >= input.events.length) {
    throw new Error(
      "Skill extraction chunk builder received an exhausted cursor.",
    );
  }

  const overlapStartIndex =
    input.cursorIndex === 0
      ? 0
      : Math.max(0, input.cursorIndex - CALL_B_OVERLAP_EVENT_COUNT);
  const baseStepPayload = buildPromptPayloadForSkillExtractionSteps({
    events: [],
    callAGuidance: input.callAGuidance,
    promptSet: input.promptSet,
    userSkillConfig: input.userSkillConfig,
    accumulated: input.accumulated,
    chunkIndex: input.chunkIndex,
  });
  const baseTerminalPayload = buildPromptPayloadForSkillExtractionTerminal({
    events: [],
    callAGuidance: input.callAGuidance,
    promptSet: input.promptSet,
    userSkillConfig: input.userSkillConfig,
    accumulated: input.accumulated,
    chunkIndex: input.chunkIndex,
    terminalChunkEndEventId:
      input.events[input.events.length - 1]?.id ?? "unknown",
  });
  const baseEstimate = Math.max(
    estimateInputTokens(
      baseStepPayload.systemPrompt,
      baseStepPayload.userPrompt,
    ),
    estimateInputTokens(
      baseTerminalPayload.systemPrompt,
      baseTerminalPayload.userPrompt,
    ),
  );
  if (baseEstimate > CALL_B_ESTIMATED_INPUT_TOKEN_LIMIT) {
    throw buildSkillExtractionChunkBudgetError(
      "Skill extraction accumulated context already exceeds the chunk budget; no automatic compression was applied",
    );
  }

  let lastFit: {
    endIndex: number;
    payload: { systemPrompt: string; userPrompt: string };
    estimatedInputTokens: number;
  } | null = null;
  for (
    let endIndex = overlapStartIndex;
    endIndex < input.events.length;
    endIndex += 1
  ) {
    const candidateEvents = input.events.slice(overlapStartIndex, endIndex + 1);
    const isTerminalChunk = endIndex >= input.events.length - 1;
    const payload = isTerminalChunk
      ? buildPromptPayloadForSkillExtractionTerminal({
          events: candidateEvents,
          callAGuidance: input.callAGuidance,
          promptSet: input.promptSet,
          userSkillConfig: input.userSkillConfig,
          accumulated: input.accumulated,
          chunkIndex: input.chunkIndex,
          terminalChunkEndEventId: input.events[endIndex]?.id ?? "unknown",
        })
      : buildPromptPayloadForSkillExtractionSteps({
          events: candidateEvents,
          callAGuidance: input.callAGuidance,
          promptSet: input.promptSet,
          userSkillConfig: input.userSkillConfig,
          accumulated: input.accumulated,
          chunkIndex: input.chunkIndex,
        });
    const estimatedInputTokens = estimateInputTokens(
      payload.systemPrompt,
      payload.userPrompt,
    );
    if (estimatedInputTokens > CALL_B_ESTIMATED_INPUT_TOKEN_LIMIT) {
      break;
    }
    lastFit = {
      endIndex,
      payload,
      estimatedInputTokens,
    };
  }

  if (lastFit === null || lastFit.endIndex < input.cursorIndex) {
    throw buildSkillExtractionChunkBudgetError(
      "Skill extraction could not fit even one new event into the chunk budget",
    );
  }

  const boundary =
    lastFit.endIndex >= input.events.length - 1
      ? { endIndex: lastFit.endIndex, usedFallbackBoundary: false }
      : chooseFallbackChunkBoundary(
          input.events,
          input.cursorIndex,
          lastFit.endIndex,
        );
  const finalEvents = input.events.slice(
    overlapStartIndex,
    boundary.endIndex + 1,
  );
  const isTerminalChunk = boundary.endIndex >= input.events.length - 1;
  const payload = isTerminalChunk
    ? buildPromptPayloadForSkillExtractionTerminal({
        events: finalEvents,
        callAGuidance: input.callAGuidance,
        promptSet: input.promptSet,
        userSkillConfig: input.userSkillConfig,
        accumulated: input.accumulated,
        chunkIndex: input.chunkIndex,
        terminalChunkEndEventId:
          input.events[boundary.endIndex]?.id ?? "unknown",
      })
    : buildPromptPayloadForSkillExtractionSteps({
        events: finalEvents,
        callAGuidance: input.callAGuidance,
        promptSet: input.promptSet,
        userSkillConfig: input.userSkillConfig,
        accumulated: input.accumulated,
        chunkIndex: input.chunkIndex,
      });
  const estimatedInputTokens = estimateInputTokens(
    payload.systemPrompt,
    payload.userPrompt,
  );

  return {
    payload,
    chunkEvents: finalEvents,
    startIndex: input.cursorIndex,
    endIndex: boundary.endIndex,
    overlapStartIndex,
    estimatedInputTokens,
    usedFallbackBoundary: boundary.usedFallbackBoundary,
    isTerminalChunk,
  };
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeWorkflowBoundaryRef(value: unknown): {
  eventId?: string;
  frameId?: number;
} {
  const eventId =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : undefined;
  const frameId = normalizeOptionalNumber(value);
  return {
    ...(eventId ? { eventId } : {}),
    ...(frameId === undefined ? {} : { frameId: Math.trunc(frameId) }),
  };
}

function normalizeSkillExtractionStepChunkResult(
  rawDraft: unknown,
): SkillExtractionStepChunkResult {
  const draftRecord = asRecord(unwrapDraftEnvelope(rawDraft));
  if (!draftRecord) {
    throw new Error("Call B step output is not a JSON object.");
  }

  return normalizeSkillExtractionStepChunkRecord(draftRecord);
}

function normalizeSkillExtractionStepChunkRecord(
  draftRecord: Record<string, unknown>,
): SkillExtractionStepChunkResult {
  const steps = extractRawSteps(draftRecord);

  const coveredThroughEventId = normalizeText(
    pickStringByKeys(draftRecord, ["coveredThroughEventId"]) ?? "",
  );
  if (!coveredThroughEventId) {
    throw new Error("Call B step output missing coveredThroughEventId.");
  }

  const assets = pickFirstDefined(draftRecord, ["assets"]);
  const coveredThroughTsMs = normalizeOptionalNumber(
    pickFirstDefined(draftRecord, ["coveredThroughTsMs"]),
  );

  return {
    steps,
    ...(assets === undefined ? {} : { assets }),
    coveredThroughEventId,
    ...(coveredThroughTsMs === undefined ? {} : { coveredThroughTsMs }),
  };
}

function normalizeSkillExtractionFieldCompletionResult(
  draftRecord: Record<string, unknown>,
): SkillExtractionFieldCompletionResult {
  return {
    shortDescription: pickFirstDefined(draftRecord, ["shortDescription"]),
    description: pickFirstDefined(draftRecord, ["description"]),
    whenToUse: pickFirstDefined(draftRecord, ["whenToUse"]),
    whenNotToUse: pickFirstDefined(draftRecord, ["whenNotToUse"]),
    inputs: pickFirstDefined(draftRecord, ["inputs"]),
    outputs: pickFirstDefined(draftRecord, ["outputs"]),
    prerequisites: pickFirstDefined(draftRecord, ["prerequisites"]),
    successCriteria: pickFirstDefined(draftRecord, ["successCriteria"]),
    failureModes: pickFirstDefined(draftRecord, ["failureModes"]),
    fallback: pickFirstDefined(draftRecord, ["fallback"]),
    examples: pickFirstDefined(draftRecord, ["examples"]),
    tags: pickFirstDefined(draftRecord, ["tags"]),
    assets: pickFirstDefined(draftRecord, ["assets"]),
  };
}

function normalizeSkillExtractionTerminalResult(
  rawDraft: unknown,
): SkillExtractionTerminalResult {
  const draftRecord = asRecord(unwrapDraftEnvelope(rawDraft));
  if (!draftRecord) {
    throw new Error("Call B terminal output is not a JSON object.");
  }

  return {
    ...normalizeSkillExtractionFieldCompletionResult(draftRecord),
    ...normalizeSkillExtractionStepChunkRecord(draftRecord),
  };
}

function buildSkillExtractionStepLabel(chunkIndex: number): string {
  return `skill-extraction-step-${String(chunkIndex).padStart(2, "0")}`;
}

function buildSkillExtractionTerminalLabel(chunkIndex: number): string {
  return `skill-extraction-terminal-${String(chunkIndex).padStart(2, "0")}`;
}

function resolveNextSkillExtractionCursor(input: {
  events: NormalizedEvent[];
  cursorIndex: number;
  chunkEndIndex: number;
  chunkStartIndex: number;
  rawReturnedCursorEventId: string;
  chunkLabel: string;
  warnings: string[];
}): {
  nextCursorIndex: number;
  usedFallbackCursor: boolean;
} {
  const returnedIndex = input.events.findIndex(
    (event) => event.id === input.rawReturnedCursorEventId,
  );
  if (
    returnedIndex < input.cursorIndex ||
    returnedIndex < input.chunkStartIndex ||
    returnedIndex > input.chunkEndIndex
  ) {
    pushWarning(
      input.warnings,
      `${input.chunkLabel} returned invalid coveredThroughEventId=${input.rawReturnedCursorEventId}; fell back to chunk end event ${input.events[input.chunkEndIndex]?.id ?? "unknown"}.`,
    );
    return {
      nextCursorIndex: input.chunkEndIndex + 1,
      usedFallbackCursor: true,
    };
  }

  const nextCursorIndex = returnedIndex + 1;
  if (nextCursorIndex <= input.cursorIndex) {
    pushWarning(
      input.warnings,
      `${input.chunkLabel} returned a non-advancing cursor at event ${input.rawReturnedCursorEventId}; fell back to chunk end event ${input.events[input.chunkEndIndex]?.id ?? "unknown"}.`,
    );
    return {
      nextCursorIndex: input.chunkEndIndex + 1,
      usedFallbackCursor: true,
    };
  }

  return {
    nextCursorIndex,
    usedFallbackCursor: false,
  };
}

async function updateTraceMeta(
  tracePaths: LlmTracePaths | null | undefined,
  meta: RequestSkillDraftTraceMeta,
): Promise<void> {
  if (!tracePaths) {
    return;
  }
  try {
    const raw = await readFile(tracePaths.jsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const currentMeta = asRecord(parsed.meta) ?? {};
    parsed.meta = {
      ...currentMeta,
      ...meta,
    };
    await writeJson(tracePaths.jsonPath, parsed);
  } catch {
    // best-effort trace enrichment
  }
}

async function runSkillExtractionWorkflow(input: {
  events: NormalizedEvent[];
  callAGuidance?: WorkflowGuidance | null;
  promptSet: LoadedPromptSet;
  userSkillConfig: UserSkillConfig;
  wireApi: OpenAiWireApi;
  baseUrl: string;
  apiKey: string;
  model: string;
  clientProfile?: OpenAiCompatibleClientProfile;
  extraHeaders?: Record<string, string>;
  skillExtractionStepProfile: ResolvedOpenClawLlmCallProfile;
  skillExtractionTerminalProfile: ResolvedOpenClawLlmCallProfile;
  promptMeta: PromptMeta;
  traceRunDir: string;
  currentInvocationCalls: LlmCallMetrics[];
  warnings: string[];
}): Promise<{
  accumulated: SkillExtractionAccumulatedState;
  terminalResult: SkillExtractionTerminalResult;
}> {
  const accumulated: SkillExtractionAccumulatedState = {
    steps: [],
    assetChunks: [],
  };
  let cursorIndex = 0;
  let chunkIndex = 1;
  let terminalResult: SkillExtractionTerminalResult | null = null;

  while (cursorIndex < input.events.length) {
    const chunkPlan = selectSkillExtractionChunkForBudget({
      events: input.events,
      cursorIndex,
      callAGuidance: input.callAGuidance,
      promptSet: input.promptSet,
      userSkillConfig: input.userSkillConfig,
      accumulated,
      chunkIndex,
    });
    const chunkLabel = chunkPlan.isTerminalChunk
      ? buildSkillExtractionTerminalLabel(chunkIndex)
      : buildSkillExtractionStepLabel(chunkIndex);
    if (chunkPlan.usedFallbackBoundary) {
      pushWarning(
        input.warnings,
        `${chunkLabel} used fallback structural boundary at event ${input.events[chunkPlan.endIndex]?.id ?? "unknown"}.`,
      );
    }
    const traceMeta: RequestSkillDraftTraceMeta = {
      chunkIndex,
      startEventId: input.events[cursorIndex]?.id,
      endEventId: input.events[chunkPlan.endIndex]?.id,
      overlapStartEventId: input.events[chunkPlan.overlapStartIndex]?.id,
      usedFallbackBoundary: chunkPlan.usedFallbackBoundary,
      usedFallbackCursor: false,
      estimatedInputTokens: chunkPlan.estimatedInputTokens,
      mode: chunkPlan.isTerminalChunk ? "terminal" : "step",
    };
    const chunkResult = await requestSkillDraftText({
      wireApi: input.wireApi,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      reasoningEffort: chunkPlan.isTerminalChunk
        ? input.skillExtractionTerminalProfile.reasoningEffort
        : input.skillExtractionStepProfile.reasoningEffort,
      clientProfile: input.clientProfile,
      extraHeaders: input.extraHeaders,
      systemPrompt: chunkPlan.payload.systemPrompt,
      userPrompt: chunkPlan.payload.userPrompt,
      requestLabel: chunkLabel,
      responseReadTimeoutMs: chunkPlan.isTerminalChunk
        ? input.skillExtractionTerminalProfile.responseReadTimeoutMs
        : input.skillExtractionStepProfile.responseReadTimeoutMs,
      responseTimeoutMode: chunkPlan.isTerminalChunk
        ? input.skillExtractionTerminalProfile.responseTimeoutMode
        : input.skillExtractionStepProfile.responseTimeoutMode,
      promptMeta: input.promptMeta,
      trace: { runDir: input.traceRunDir, label: chunkLabel },
      traceMeta,
    });
    input.currentInvocationCalls.push(chunkResult.metrics);

    const parsedChunk = chunkPlan.isTerminalChunk
      ? normalizeSkillExtractionTerminalResult(parseLooseJson(chunkResult.text))
      : normalizeSkillExtractionStepChunkResult(
          parseLooseJson(chunkResult.text),
        );
    if (parsedChunk.assets !== undefined) {
      accumulated.assetChunks.push({
        chunkIndex,
        assets: parsedChunk.assets,
      });
    }
    if (parsedChunk.steps.length === 0) {
      pushWarning(
        input.warnings,
        `${chunkLabel} returned no new steps; continued with cursor advancement only.`,
      );
    } else {
      accumulated.steps.push(...parsedChunk.steps);
    }

    if (chunkPlan.isTerminalChunk) {
      terminalResult = parsedChunk;
      await updateTraceMeta(chunkResult.tracePaths, {
        ...traceMeta,
        returnedCursorEventId: parsedChunk.coveredThroughEventId,
        usedFallbackCursor: false,
      });
      cursorIndex = input.events.length;
      chunkIndex += 1;
      break;
    }

    const cursorResolution = resolveNextSkillExtractionCursor({
      events: input.events,
      cursorIndex,
      chunkEndIndex: chunkPlan.endIndex,
      chunkStartIndex: chunkPlan.overlapStartIndex,
      rawReturnedCursorEventId: parsedChunk.coveredThroughEventId,
      chunkLabel,
      warnings: input.warnings,
    });
    await updateTraceMeta(chunkResult.tracePaths, {
      ...traceMeta,
      returnedCursorEventId: parsedChunk.coveredThroughEventId,
      usedFallbackCursor: cursorResolution.usedFallbackCursor,
    });

    cursorIndex = cursorResolution.nextCursorIndex;
    chunkIndex += 1;
  }
  if (!terminalResult) {
    throw new Error(
      "Skill extraction did not produce a terminal chunk result.",
    );
  }

  return {
    accumulated,
    terminalResult,
  };
}

/**
 * EN: Builds the call B event view, removing null-valued fields and omitting rawRef.
 */
function buildPromptEventsForSteps(
  events: NormalizedEvent[],
): StepsPromptEvent[] {
  return events.map((event) => ({
    id: event.id,
    source: event.source,
    tsIso: event.tsIso,
    tsMs: event.tsMs,
    eventType: event.eventType,
    ...(event.appName !== null ? { appName: event.appName } : {}),
    ...(event.windowName !== null ? { windowName: event.windowName } : {}),
    ...(event.textContent !== null ? { textContent: event.textContent } : {}),
    ...(event.x !== null ? { x: event.x } : {}),
    ...(event.y !== null ? { y: event.y } : {}),
    ...(event.keyCode !== null ? { keyCode: event.keyCode } : {}),
    ...(event.modifiers !== null ? { modifiers: event.modifiers } : {}),
    ...(event.browserUrl !== null ? { browserUrl: event.browserUrl } : {}),
    ...(event.frameId !== null ? { frameId: event.frameId } : {}),
  }));
}

export function normalizePlannerOptimizationDraft(
  rawDraft: unknown,
): PlannerOptimizationDraft {
  const draftRecord = asRecord(unwrapDraftEnvelope(rawDraft));
  if (!draftRecord) {
    throw new Error("Planner optimization output is not a JSON object.");
  }

  const candidateDraft: PlannerOptimizationDraft = {
    skillName: pickStringByKeys(draftRecord, ["skillName"]),
    shortDescription: pickStringByKeys(draftRecord, ["shortDescription"]),
    description: pickStringByKeys(draftRecord, ["description"]),
    whenToUse: pickOptionalNormalizedStringList(draftRecord, ["whenToUse"]),
  };

  try {
    return plannerOptimizationDraftSchema.parse(candidateDraft);
  } catch (error) {
    throw new Error(
      `Planner optimization normalization failed: ${summarizeLlmError(error)}`,
    );
  }
}

export function normalizePredictedReusableScenarios(
  rawDraft: unknown,
  warnings: string[],
): PredictedReuseScenario[] {
  const unwrapped = unwrapDraftEnvelope(rawDraft);
  const draftRecord = asRecord(unwrapped);
  const rawScenarios = Array.isArray(unwrapped)
    ? unwrapped
    : draftRecord
      ? extractScenarioEntries(draftRecord)
      : [];
  if (rawScenarios.length === 0) {
    throw new Error("Scenario prediction output contains no scenario entries.");
  }

  const normalized = rawScenarios
    .map((item, index) =>
      normalizePredictedReusableScenario(item, index, warnings),
    )
    .filter(
      (item): item is PredictedReuseScenario =>
        item !== null && item !== undefined,
    );
  const deduped = ensureUniqueScenarioIds(normalized);
  if (deduped.length < 1 || deduped.length > 3) {
    throw new Error(
      `Scenario prediction must yield 1-3 scenarios, received ${deduped.length}.`,
    );
  }
  return deduped;
}

function extractScenarioEntries(
  draftRecord: Record<string, unknown>,
): unknown[] {
  const direct = pickFirstDefined(draftRecord, ["scenarios"]);
  if (Array.isArray(direct)) {
    return direct;
  }
  const directRecord = asRecord(direct);
  if (
    directRecord &&
    ("scenarioId" in directRecord || "nextUseHypothesis" in directRecord)
  ) {
    return [directRecord];
  }
  if ("scenarioId" in draftRecord || "nextUseHypothesis" in draftRecord) {
    return [draftRecord];
  }
  return [];
}

function normalizePredictedReusableScenario(
  rawScenario: unknown,
  index: number,
  warnings: string[],
): PredictedReuseScenario | null {
  const record = asRecord(rawScenario);
  if (!record) {
    pushWarning(
      warnings,
      `Dropped one predicted scenario at index ${index} because it is not an object.`,
    );
    return null;
  }

  const rawScenarioId = normalizeNullableText(
    pickStringByKeys(record, ["scenarioId"]),
  );
  const nextUseHypothesis =
    normalizeNullableText(pickStringByKeys(record, ["nextUseHypothesis"])) ??
    "";
  const scenarioId = rawScenarioId
    ? sanitizeScenarioIdentifier(rawScenarioId)
    : "";
  const candidate: PredictedReuseScenarioDraft = {
    scenarioId,
    nextUseHypothesis,
  };

  try {
    return predictedReuseScenarioDraftSchema.parse(candidate);
  } catch (error) {
    pushWarning(
      warnings,
      `Dropped one predicted scenario at index ${index}: ${summarizeLlmError(error)}`,
    );
    return null;
  }
}

function buildFallbackScenarioId(value: string, index: number): string {
  const sanitized = sanitizeScenarioIdentifier(value);
  return sanitized.length > 0 ? sanitized : `scenario-${index + 1}`;
}

function ensureUniqueScenarioIds(
  scenarios: PredictedReuseScenario[],
): PredictedReuseScenario[] {
  const seen = new Map<string, number>();
  return scenarios.map((scenario) => {
    const count = (seen.get(scenario.scenarioId) ?? 0) + 1;
    seen.set(scenario.scenarioId, count);
    if (count === 1) {
      return scenario;
    }
    return {
      ...scenario,
      scenarioId: `${scenario.scenarioId}-${count}`,
    };
  });
}

export function normalizeGeneralizedSkillDraft(input: {
  rawDraft: unknown;
  events: NormalizedEvent[];
  warnings: string[];
}): GeneralizedSkillDraft {
  const unwrapped = unwrapDraftEnvelope(input.rawDraft);
  const draftRecord = asRecord(unwrapped);
  if (!draftRecord) {
    throw new Error("Generalized skill output is not a JSON object.");
  }

  const fallbackContextEventIds = findFallbackContextEventIds(input.events);
  const steps = normalizeStepDrafts(
    extractRawSteps(draftRecord),
    input.events,
    fallbackContextEventIds,
    input.warnings,
  );
  const candidate: GeneralizedSkillDraft = {
    ...(normalizeOptionalTextField(pickStringByKeys(draftRecord, ["skillName"]))
      ? {
          skillName: normalizeText(
            pickStringByKeys(draftRecord, ["skillName"])!,
          ),
        }
      : {}),
    ...(normalizeOptionalTextField(
      pickStringByKeys(draftRecord, ["shortDescription"]),
    )
      ? {
          shortDescription: normalizeText(
            pickStringByKeys(draftRecord, ["shortDescription"])!,
          ),
        }
      : {}),
    ...(normalizeOptionalTextField(
      pickStringByKeys(draftRecord, ["description"]),
    )
      ? {
          description: normalizeText(
            pickStringByKeys(draftRecord, ["description"])!,
          ),
        }
      : {}),
    ...(normalizeOptionalTextField(pickStringByKeys(draftRecord, ["goal"]))
      ? {
          goal: normalizeText(pickStringByKeys(draftRecord, ["goal"])!),
        }
      : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["whenToUse"]),
    )
      ? {
          whenToUse:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["whenToUse"]),
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["whenNotToUse"]),
    )
      ? {
          whenNotToUse:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["whenNotToUse"]),
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalSkillFieldList(
      pickFirstDefined(draftRecord, ["inputs"]),
      "inputs",
      input.warnings,
    )
      ? {
          inputs:
            normalizeOptionalSkillFieldList(
              pickFirstDefined(draftRecord, ["inputs"]),
              "inputs",
              input.warnings,
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalSkillFieldList(
      pickFirstDefined(draftRecord, ["outputs"]),
      "outputs",
      input.warnings,
    )
      ? {
          outputs:
            normalizeOptionalSkillFieldList(
              pickFirstDefined(draftRecord, ["outputs"]),
              "outputs",
              input.warnings,
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["prerequisites"]),
    )
      ? {
          prerequisites:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["prerequisites"]),
            ) ?? undefined,
        }
      : {}),
    ...(steps.length > 0 ? { steps } : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["successCriteria"]),
    )
      ? {
          successCriteria:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["successCriteria"]),
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["failureModes"]),
    )
      ? {
          failureModes:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["failureModes"]),
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["fallback"]),
    )
      ? {
          fallback:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["fallback"]),
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["examples"]),
    )
      ? {
          examples:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["examples"]),
            ) ?? undefined,
        }
      : {}),
    ...(normalizeOptionalStringListField(
      pickFirstDefined(draftRecord, ["tags"]),
    )
      ? {
          tags:
            normalizeOptionalStringListField(
              pickFirstDefined(draftRecord, ["tags"]),
            ) ?? undefined,
        }
      : {}),
  };

  if (!Object.values(candidate).some((value) => value !== undefined)) {
    throw new Error("Generalized skill output contains no usable fields.");
  }

  try {
    return generalizedSkillDraftSchema.parse(candidate);
  } catch (error) {
    throw new Error(
      `Generalized skill normalization failed: ${summarizeLlmError(error)}`,
    );
  }
}

export function applyScenarioGeneralizationToSkill(input: {
  skill: OpenClawSkill;
  draft: GeneralizedSkillDraft;
  events: NormalizedEvent[];
  scenario: PredictedReuseScenario;
  generatedAt: string;
  warnings: string[];
}): OpenClawSkill {
  const candidateName =
    normalizeNullableText(input.draft.skillName) ?? input.skill.skillName;
  const goal = adjustGoalForAutonomous(
    normalizeNullableText(input.draft.goal) ?? input.skill.goal,
  );
  const generalizedSteps =
    input.draft.steps && input.draft.steps.length > 0
      ? stripMaterializedStepContext(
          materializeStepsFromDraft(
            input.draft.steps,
            input.events,
            input.warnings,
          ),
        )
      : null;
  if (
    input.draft.steps &&
    input.draft.steps.length > 0 &&
    (!generalizedSteps || generalizedSteps.length === 0)
  ) {
    pushWarning(
      input.warnings,
      `Scenario ${input.scenario.scenarioId} produced no usable generalized steps; reused specific steps.`,
    );
  }
  const skillName = resolvePlannerOptimizedSkillName({
    candidateName,
    goal,
  });
  const description =
    normalizeNullableText(input.draft.description) ?? input.skill.description;
  const shortDescription = buildSkillShortDescription(
    normalizeNullableText(input.draft.shortDescription) ??
      input.skill.shortDescription ??
      description,
  );
  const generalizedSkill: OpenClawSkill = {
    ...input.skill,
    skillId: createSkillId(
      input.skill.source.runId,
      input.skill.source.episodeId,
      `${input.skill.executionMode ?? "autonomous"}:${skillName}:${input.scenario.scenarioId}`,
      input.generatedAt,
    ),
    skillName,
    generatedAt: input.generatedAt,
    shortDescription,
    description,
    goal,
    whenToUse: normalizeStringList(
      input.draft.whenToUse ?? input.skill.whenToUse,
      input.skill.whenToUse,
    ),
    whenNotToUse: normalizeStringList(
      input.draft.whenNotToUse ?? input.skill.whenNotToUse,
      input.skill.whenNotToUse,
    ),
    inputs: normalizeSkillFields(input.draft.inputs ?? input.skill.inputs),
    outputs: normalizeSkillFields(input.draft.outputs ?? input.skill.outputs),
    prerequisites: normalizeStringList(
      input.draft.prerequisites ?? input.skill.prerequisites,
      input.skill.prerequisites,
    ),
    steps:
      generalizedSteps && generalizedSteps.length > 0
        ? generalizedSteps
        : input.skill.steps,
    successCriteria: normalizeStringList(
      input.draft.successCriteria ?? input.skill.successCriteria,
      input.skill.successCriteria,
    ),
    failureModes: normalizeStringList(
      input.draft.failureModes ?? input.skill.failureModes,
      input.skill.failureModes,
    ),
    fallback: normalizeStringList(
      input.draft.fallback ?? input.skill.fallback,
      input.skill.fallback,
    ),
    examples: normalizeStringList(
      input.draft.examples ?? input.skill.examples,
      input.skill.examples,
    ),
    tags: normalizeStringList(
      input.draft.tags ?? input.skill.tags,
      input.skill.tags,
    ),
  };

  return appendWarningsToSkillFallback(generalizedSkill, input.warnings);
}

export function applyPlannerOptimizationToSkill(input: {
  skill: OpenClawSkill;
  draft: PlannerOptimizationDraft;
  runId: string;
  episodeId: string;
  generatedAt: string;
}): OpenClawSkill {
  const resolvedSkillName = resolvePlannerOptimizedSkillName({
    candidateName:
      normalizeNullableText(input.draft.skillName) ?? input.skill.skillName,
    goal: input.skill.goal,
  });
  const resolvedDescription = buildPlannerPriorityDescription(
    normalizeNullableText(input.draft.description) ??
      normalizeNullableText(input.skill.description) ??
      input.skill.goal,
  );
  const resolvedShortDescription = buildSkillShortDescription(
    normalizeNullableText(input.draft.shortDescription) ??
      normalizeNullableText(input.skill.shortDescription) ??
      normalizeNullableText(input.draft.description) ??
      normalizeNullableText(input.skill.description) ??
      input.skill.goal,
  );
  const whenToUse = buildPlannerPriorityWhenToUse(
    normalizeStringList(
      input.draft.whenToUse ?? input.skill.whenToUse,
      input.skill.whenToUse,
    ),
  );

  const optimizedSkill: OpenClawSkill = {
    ...input.skill,
    skillName: resolvedSkillName,
    shortDescription: resolvedShortDescription,
    description: resolvedDescription,
    whenToUse,
  };

  if (optimizedSkill.skillName !== input.skill.skillName) {
    optimizedSkill.skillId = createSkillId(
      input.runId,
      input.episodeId,
      `${optimizedSkill.executionMode ?? "autonomous"}:${optimizedSkill.skillName}`,
      input.generatedAt,
    );
  }

  return optimizedSkill;
}

function resolvePlannerOptimizedSkillName(input: {
  candidateName: string;
  goal: string;
}): string {
  const candidateName = normalizeText(input.candidateName).replace(
    /[.!?]+$/g,
    "",
  );
  const goal = normalizeText(input.goal).replace(/[.!?]+$/g, "");
  if (!candidateName) {
    return goal || MISSING_FIELD_TEXT;
  }

  const pollutedByInternalTerms = /(screenpipe|codex|planner)/i.test(
    candidateName,
  );
  const overlyGeneric =
    candidateName.length < 4 ||
    /generic|daily|workflow skill|skill\b|workflow$/i.test(candidateName);
  if ((pollutedByInternalTerms || overlyGeneric) && goal) {
    return goal;
  }
  return candidateName;
}

function buildPlannerPriorityDescription(baseDescription: string): string {
  const normalizedBase = normalizeText(baseDescription);
  return unique([
    normalizedBase,
    "This skill was generated by the skill learner from the user's real successful path, making it safer and closer to the user's original intent.",
    "This is a multi-step workflow. When the situation matches, this skill should be preferred so that key steps are not missed by ad-hoc manual reasoning.",
  ])
    .filter((value) => value.length > 0)
    .join(" ");
}

function buildPlannerPriorityWhenToUse(current: string[]): string[] {
  return unique([
    ...current,
    "Use this skill when the task goal closely matches the skill description and you want to follow the user's previously validated real path.",
    "Use this skill when the task includes multiple checks, entries, or confirmation steps and ad-hoc manual reasoning could easily miss something important.",
  ]).slice(0, 6);
}

export function appendWarningsToSkillFallback(
  skill: OpenClawSkill,
  warnings: string[],
): OpenClawSkill {
  if (warnings.length === 0) {
    return skill;
  }
  return {
    ...skill,
    fallback: unique([
      ...skill.fallback,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ]),
  };
}

/**
 * EN: Normalizes required string field, returning placeholder and recording warning when missing.
 * @param value raw value.
 * @param fieldLabel field label.
 * @param warnings warning sink.
 * @returns normalized field text.
 */
function normalizeRequiredStringField(
  value: string | undefined,
  fieldLabel: string,
  warnings: string[],
): string {
  const normalized = normalizeText(value || "");
  if (!normalized) {
    pushWarning(
      warnings,
      "LLM output missing " + fieldLabel + "; used placeholder.",
    );
    return MISSING_FIELD_TEXT;
  }
  return normalized;
}

/**
 * EN: Normalizes required string-list field, returning placeholder and recording warning when missing.
 * @param value raw value.
 * @param fieldLabel field label.
 * @param warnings warning sink.
 * @returns normalized field list.
 */
function normalizeRequiredStringListField(
  value: unknown,
  fieldLabel: string,
  warnings: string[],
): string[] {
  const list = normalizeFlexibleStringList(value, []);
  if (list.length === 0) {
    pushWarning(
      warnings,
      "LLM output missing " + fieldLabel + "; used placeholder.",
    );
    return [MISSING_FIELD_TEXT];
  }
  return list;
}

function normalizeOptionalTextField(
  value: string | undefined,
): string | undefined {
  const normalized = normalizeNullableText(value);
  return normalized ?? undefined;
}

function normalizeOptionalStringListField(
  value: unknown,
): string[] | undefined {
  const list = normalizeFlexibleStringList(value, []);
  return list.length > 0 ? list : undefined;
}

function normalizeOptionalSkillFieldList(
  value: unknown,
  fieldLabel: "inputs" | "outputs",
  warnings: string[],
): OpenClawSkillField[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const items = Array.isArray(value) ? value : [value];
  const normalized: OpenClawSkillField[] = [];

  for (const [index, item] of items.entries()) {
    if (typeof item === "string") {
      const name = normalizeText(item);
      if (name.length === 0) {
        continue;
      }
      normalized.push({
        name,
        description: "",
      });
      continue;
    }

    const record = asRecord(item);
    if (!record) {
      pushWarning(
        warnings,
        `LLM output contains invalid ${fieldLabel}[${index}] entry; skipped.`,
      );
      continue;
    }

    const name = normalizeNullableText(
      pickStringByKeys(record, [
        "name",
        "title",
        "label",
        "key",
        "name",
        "fieldName",
      ]),
    );
    if (!name) {
      pushWarning(
        warnings,
        `LLM output missing ${fieldLabel}[${index}].name; skipped.`,
      );
      continue;
    }

    const description =
      normalizeNullableText(
        pickStringByKeys(record, [
          "description",
          "desc",
          "details",
          "summary",
          "description",
          "notes",
        ]),
      ) ?? "";
    const required = normalizeOptionalBoolean(
      pickFirstDefined(record, ["required", "mandatory", "must"]),
    );
    normalized.push({
      name,
      description,
      ...(required === null ? {} : { required }),
    });
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalSkillAssetList(
  value: unknown,
  warnings: string[],
): OpenClawSkillAsset[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const legacyRecord = asRecord(value);
  if (
    legacyRecord &&
    (Array.isArray(legacyRecord.credentials) ||
      Array.isArray(legacyRecord.texts) ||
      Array.isArray(legacyRecord.urls))
  ) {
    return normalizeLegacySkillAssetRecord(legacyRecord);
  }

  const items = Array.isArray(value) ? value : [value];
  const normalized: OpenClawSkillAsset[] = [];
  for (const [index, item] of items.entries()) {
    if (typeof item === "string") {
      const text = normalizeText(item);
      if (text.length === 0) {
        continue;
      }
      normalized.push({
        name: `Asset ${index + 1}`,
        value: text,
      });
      continue;
    }

    const record = asRecord(item);
    if (!record) {
      pushWarning(
        warnings,
        `LLM output contains invalid assets[${index}] entry; skipped.`,
      );
      continue;
    }

    const name = normalizeNullableText(
      pickStringByKeys(record, ["name", "title", "label"]),
    );
    const normalizedValue = normalizeSkillAssetValue(
      pickFirstDefined(record, [
        "value",
        "content",
        "values",
        "payload",
        "content",
      ]),
    );
    if (!name || normalizedValue === null) {
      pushWarning(
        warnings,
        `LLM output missing assets[${index}] required fields; skipped.`,
      );
      continue;
    }
    const notes = normalizeNullableText(
      pickStringByKeys(record, [
        "notes",
        "note",
        "description",
        "notes",
        "description",
      ]),
    );
    normalized.push({
      name,
      value: normalizedValue,
      ...(notes ? { notes } : {}),
    });
  }

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeLegacySkillAssetRecord(
  record: Record<string, unknown>,
): OpenClawSkillAsset[] | undefined {
  const output: OpenClawSkillAsset[] = [];

  const credentials = Array.isArray(record.credentials)
    ? record.credentials
    : [];
  credentials.forEach((entry, index) => {
    const credential = asRecord(entry);
    if (!credential) {
      return;
    }
    const account =
      normalizeNullableText(
        pickStringByKeys(credential, ["account", "username", "name"]),
      ) ?? `Credential ${index + 1}`;
    const password = normalizeNullableText(
      pickStringByKeys(credential, ["password", "secret"]),
    );
    const value: Record<string, string> = password
      ? { account, password }
      : { account };
    output.push({
      name: account,
      value,
    });
  });

  const texts = Array.isArray(record.texts) ? record.texts : [];
  texts.forEach((entry, index) => {
    if (typeof entry !== "string") {
      return;
    }
    const text = normalizeText(entry);
    if (text.length === 0) {
      return;
    }
    output.push({
      name: `Text ${index + 1}`,
      value: text,
    });
  });

  const urls = Array.isArray(record.urls) ? record.urls : [];
  urls.forEach((entry, index) => {
    if (typeof entry !== "string") {
      return;
    }
    const url = normalizeText(entry);
    if (url.length === 0) {
      return;
    }
    output.push({
      name: `URL ${index + 1}`,
      value: url,
    });
  });

  return output.length > 0 ? output : undefined;
}

function normalizeSkillAssetValue(
  value: unknown,
): OpenClawSkillAsset["value"] | null {
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized.length > 0 ? normalized : null;
  }
  if (Array.isArray(value)) {
    const normalized = unique(
      value
        .map((item) =>
          typeof item === "string"
            ? normalizeText(item)
            : typeof item === "number" || typeof item === "boolean"
              ? normalizeText(String(item))
              : "",
        )
        .filter((item) => item.length > 0),
    );
    return normalized.length > 0 ? normalized : null;
  }
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const entries = Object.entries(record)
    .map(([key, rawValue]) => {
      const normalizedKey = normalizeText(key);
      const normalizedValue =
        typeof rawValue === "string"
          ? normalizeText(rawValue)
          : typeof rawValue === "number" || typeof rawValue === "boolean"
            ? normalizeText(String(rawValue))
            : "";
      return [normalizedKey, normalizedValue] as const;
    })
    .filter(([key, rawValue]) => key.length > 0 && rawValue.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "required"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "n", "0", "optional"].includes(normalized)) {
      return false;
    }
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  return null;
}

/**
 * EN: Normalizes raw LLM draft into internal contract, tolerating envelope wrappers.
 * @param rawDraft raw LLM output in arbitrary JSON shape.
 * @param events normalized event timeline for current episode.
 * @returns normalized draft and normalization warnings.
 */
function normalizeLlmDraft(
  rawDraft: unknown,
  events: NormalizedEvent[],
): { draft: LlmSkillDraft; warnings: string[] } {
  const warnings: string[] = [];
  const unwrapped = unwrapDraftEnvelope(rawDraft);
  const draftRecord = asRecord(unwrapped);

  if (!draftRecord) {
    throw new Error("LLM output is not a JSON object.");
  }

  const fallbackContextEventIds = findFallbackContextEventIds(events);
  const skillName = pickStringByKeys(draftRecord, ["skillName"]);
  const goal = normalizeRequiredStringField(
    pickStringByKeys(draftRecord, ["goal"]),
    "goal",
    warnings,
  );
  const whenToUse = normalizeRequiredStringListField(
    pickFirstDefined(draftRecord, ["whenToUse"]),
    "whenToUse",
    warnings,
  );
  const prerequisites = normalizeRequiredStringListField(
    pickFirstDefined(draftRecord, ["prerequisites"]),
    "prerequisites",
    warnings,
  );
  const successCriteria = normalizeRequiredStringListField(
    pickFirstDefined(draftRecord, ["successCriteria"]),
    "successCriteria",
    warnings,
  );
  const fallback = normalizeRequiredStringListField(
    pickFirstDefined(draftRecord, ["fallback"]),
    "fallback",
    warnings,
  );
  const description = normalizeOptionalTextField(
    pickStringByKeys(draftRecord, ["description"]),
  );
  const shortDescription = normalizeOptionalTextField(
    pickStringByKeys(draftRecord, ["shortDescription"]),
  );
  const whenNotToUse = normalizeOptionalStringListField(
    pickFirstDefined(draftRecord, ["whenNotToUse"]),
  );
  const inputs = normalizeOptionalSkillFieldList(
    pickFirstDefined(draftRecord, ["inputs"]),
    "inputs",
    warnings,
  );
  const outputs = normalizeOptionalSkillFieldList(
    pickFirstDefined(draftRecord, ["outputs"]),
    "outputs",
    warnings,
  );
  const failureModes = normalizeOptionalStringListField(
    pickFirstDefined(draftRecord, ["failureModes"]),
  );
  const examples = normalizeOptionalStringListField(
    pickFirstDefined(draftRecord, ["examples"]),
  );
  const tags = normalizeOptionalStringListField(
    pickFirstDefined(draftRecord, ["tags"]),
  );
  const assets = normalizeOptionalSkillAssetList(
    pickFirstDefined(draftRecord, ["assets"]),
    warnings,
  );

  const rawSteps = extractRawSteps(draftRecord);
  const normalizedSteps = normalizeStepDrafts(
    rawSteps,
    events,
    fallbackContextEventIds,
    warnings,
  );

  if (normalizedSteps.length === 0) {
    throw new Error("LLM output contains no usable steps.");
  }

  const candidateDraft: LlmSkillDraft = {
    skillName: skillName ? normalizeText(skillName) : undefined,
    ...(shortDescription ? { shortDescription } : {}),
    ...(description ? { description } : {}),
    goal: normalizeText(goal),
    whenToUse,
    ...(whenNotToUse ? { whenNotToUse } : {}),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
    prerequisites,
    steps: normalizedSteps.length > 0 ? normalizedSteps : undefined,
    successCriteria,
    ...(failureModes ? { failureModes } : {}),
    fallback,
    ...(examples ? { examples } : {}),
    ...(tags ? { tags } : {}),
    ...(assets ? { assets } : {}),
  };

  try {
    return {
      draft: llmSkillDraftSchema.parse(candidateDraft),
      warnings,
    };
  } catch (error) {
    throw new Error(
      `LLM draft normalization failed: ${summarizeLlmError(error)}`,
    );
  }
}

/**
 * EN: Condenses error text to avoid dumping massive schema/response payloads into summary.
 * @param error unknown error object.
 * @returns short readable error summary.
 */
export function summarizeLlmError(error: unknown): string {
  const message = normalizeText(toErrorMessage(error));
  if (message.length <= MAX_ERROR_SUMMARY_LENGTH) {
    return message;
  }
  return `${message.slice(0, MAX_ERROR_SUMMARY_LENGTH - 1)}…`;
}

/**
 * EN: Extracts canonical `steps` from draft, supporting array/string/object-map variants.
 * @param draftRecord draft object record.
 * @returns raw step entries.
 */
function extractRawSteps(draftRecord: Record<string, unknown>): unknown[] {
  return extractRawStepsWithKeys(draftRecord, ["steps"]);
}

function extractRawStepsWithKeys(
  draftRecord: Record<string, unknown>,
  keys: string[],
): unknown[] {
  const direct = pickFirstDefined(draftRecord, keys);
  const fromDirect = toStepArray(direct);
  if (fromDirect.length > 0) {
    return fromDirect;
  }

  const wrapper = asRecord(
    pickFirstDefined(draftRecord, ["plan", "skill", "result", "data"]),
  );
  if (!wrapper) {
    return [];
  }
  const nested = pickFirstDefined(wrapper, keys);
  return toStepArray(nested);
}

/**
 * EN: Converts arbitrary values into a step-entry array.
 * @param value raw value.
 * @returns step entry array.
 */
function toStepArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return splitLooseLines(value);
  }

  const record = asRecord(value);
  if (!record) {
    return [];
  }

  const items = pickFirstDefined(record, ["items", "list", "entries"]);
  if (Array.isArray(items)) {
    return items;
  }

  const numberedEntries = Object.entries(record)
    .filter(([key]) => /^\d+$/.test(key))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, item]) => item);
  if (numberedEntries.length > 0) {
    return numberedEntries;
  }

  return [];
}

/**
 * EN: Normalizes step drafts, supporting string-only steps and canonical field names.
 * @param rawSteps raw step entries.
 * @param events normalized event list.
 * @param fallbackContextEventIds fallback context-event id pool.
 * @param warnings warning sink.
 * @returns normalized step drafts.
 */
function normalizeStepDrafts(
  rawSteps: unknown[],
  events: NormalizedEvent[],
  fallbackContextEventIds: string[],
  warnings: string[],
): LlmStepDraft[] {
  const output: LlmStepDraft[] = [];
  const knownApps = findKnownApps(events);

  for (const [index, rawStep] of rawSteps.entries()) {
    const fallbackContextEventId =
      fallbackContextEventIds[index % fallbackContextEventIds.length] ??
      events[0]?.id;
    if (!fallbackContextEventId) {
      continue;
    }
    const fallbackEvent =
      events.find((event) => event.id === fallbackContextEventId) ?? events[0];
    if (!fallbackEvent) {
      continue;
    }

    if (typeof rawStep === "string") {
      const instruction = normalizeText(rawStep);
      if (!instruction) {
        continue;
      }
      output.push(
        ...expandMultiOperationAppDrafts(
          {
            instruction,
            intent: "Advance the current task flow.",
            operationApp: MISSING_OPERATION_APP_FROM_LLM,
            hints: [],
            contextEventId: fallbackContextEventId,
            contextEventType: fallbackEvent.eventType,
            contextAppName: null,
            contextWindowName: null,
          },
          knownApps,
          warnings,
          index,
        ),
      );
      continue;
    }

    const record = asRecord(rawStep);
    if (!record) {
      pushWarning(
        warnings,
        `Dropped one LLM step due to unsupported step shape at index ${index}.`,
      );
      continue;
    }

    const instruction = normalizeText(
      pickStringByKeys(record, ["instruction"]) ?? "",
    );
    if (!instruction) {
      pushWarning(
        warnings,
        `Dropped one LLM step due to empty instruction at index ${index}.`,
      );
      continue;
    }

    const intent = normalizeText(
      pickStringByKeys(record, ["intent"]) ?? "Advance the current task flow.",
    );

    const contextEventType =
      normalizeEventType(pickFirstDefined(record, ["contextEventType"])) ??
      fallbackEvent.eventType;
    const contextAppName =
      normalizeNullableText(pickStringByKeys(record, ["contextAppName"])) ??
      null;
    const contextWindowName =
      normalizeNullableText(pickStringByKeys(record, ["contextWindowName"])) ??
      null;
    const operationApp =
      pickStringByKeys(record, ["operationApp"]) ??
      MISSING_OPERATION_APP_FROM_LLM;
    const hints = normalizeFlexibleStringList(
      pickFirstDefined(record, ["hints"]),
      [],
    ).slice(0, MAX_HINTS_PER_STEP);

    output.push(
      ...expandMultiOperationAppDrafts(
        {
          instruction,
          intent,
          operationApp: normalizeText(operationApp),
          hints,
          contextEventId: fallbackContextEventId,
          contextEventType,
          contextAppName,
          contextWindowName,
        },
        knownApps,
        warnings,
        index,
      ),
    );
  }

  if (output.length === 0 && rawSteps.length > 0) {
    pushWarning(
      warnings,
      "LLM provided steps but none were usable after normalization.",
    );
  }

  return output;
}

function resolveOperationAppLabel(
  appName: string | null | undefined,
  windowName: string | null | undefined,
): string {
  const normalizedApp = normalizeNullableText(appName);
  if (normalizedApp) {
    return normalizedApp;
  }
  void windowName;
  return MISSING_OPERATION_APP_FROM_LLM;
}

function expandMultiOperationAppDrafts(
  draft: LlmStepDraft,
  knownApps: string[],
  warnings: string[],
  stepIndex: number,
): LlmStepDraft[] {
  const mentionedApps = collectMentionedApps(
    `${draft.operationApp} ${draft.instruction} ${draft.intent}`,
    knownApps,
  );
  const finalApps =
    mentionedApps.length > 0
      ? mentionedApps
      : [normalizeText(draft.operationApp)].filter((value) => value.length > 0);

  if (finalApps.length <= 1) {
    return [
      {
        ...draft,
        operationApp:
          finalApps[0] ??
          resolveOperationAppLabel(
            draft.contextAppName,
            draft.contextWindowName,
          ),
      },
    ];
  }

  pushWarning(
    warnings,
    `Split one multi-app LLM step into ${finalApps.length} single-app steps at index ${stepIndex}.`,
  );
  return finalApps.map((operationApp) => ({
    ...draft,
    operationApp,
    hints: unique([
      `Perform this sub-step only inside ${operationApp}.`,
      ...(draft.hints ?? []),
    ]).slice(0, MAX_HINTS_PER_STEP),
  }));
}

function findKnownApps(events: NormalizedEvent[]): string[] {
  return unique(
    events
      .map((event) => normalizeNullableText(event.appName))
      .filter((value): value is string => value !== null),
  );
}

function collectMentionedApps(text: string, knownApps: string[]): string[] {
  const normalizedText = normalizeText(text).toLowerCase();
  if (!normalizedText) {
    return [];
  }

  const rankedKnownApps = knownApps
    .map((app) => ({
      app,
      index: normalizedText.indexOf(app.toLowerCase()),
    }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.app);
  if (rankedKnownApps.length > 0) {
    return unique(rankedKnownApps);
  }

  return [];
}

/**
 * EN: Computes fallback context-event id pool, preferring non-OCR anchor events.
 * @param events event list.
 * @returns non-empty ID list.
 */
function findFallbackContextEventIds(events: NormalizedEvent[]): string[] {
  const anchors = events.filter((event) => event.eventType !== "ocr");
  const source = anchors.length > 0 ? anchors : events;
  const ids = source.map((event) => event.id);
  if (ids.length > 0) {
    return ids;
  }
  return events[0] ? [events[0].id] : ["missing-event-id"];
}

/**
 * EN: Normalizes inputs into string list, supporting arrays/multiline/semicolon-separated text.
 * @param value raw input.
 * @param fallback fallback list.
 * @returns normalized list.
 */
function normalizeFlexibleStringList(
  value: unknown,
  fallback: string[],
): string[] {
  if (Array.isArray(value)) {
    return normalizeStringList(
      value
        .map((item) => (typeof item === "string" ? item : ""))
        .filter((item) => item.length > 0),
      fallback,
    );
  }
  if (typeof value === "string") {
    const lines = splitLooseLines(value);
    return normalizeStringList(lines.length > 0 ? lines : [value], fallback);
  }

  return normalizeStringList([], fallback);
}

/**
 * EN: Splits loose text into lines (supports numbering, semicolons and newlines).
 * @param value input text.
 * @returns split fragments.
 */
function splitLooseLines(value: string): string[] {
  return value
    .split(/\r?\n|[;；]+/)
    .map((line) => line.replace(/^\s*[-*•\d.()]+\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * EN: Maps event-type synonyms into the contract enum.
 * @param value raw event type value.
 * @returns normalized event type or null.
 */
function normalizeEventType(value: unknown): EventType | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "_");
  if (!normalized) {
    return null;
  }

  const mapping: Record<string, EventType> = {
    click: "click",
    tap: "click",
    press: "click",
    select: "click",
    move: "move",
    hover: "move",
    mouse_move: "move",
    scroll: "scroll",
    wheel: "scroll",
    swipe: "scroll",
    key: "key",
    keydown: "key",
    keypress: "key",
    shortcut: "key",
    hotkey: "key",
    text: "text",
    input: "text",
    typing: "text",
    type: "text",
    app_switch: "app_switch",
    switch_app: "app_switch",
    open_app: "app_switch",
    launch_app: "app_switch",
    window_focus: "window_focus",
    focus_window: "window_focus",
    switch_window: "window_focus",
    clipboard: "clipboard",
    copy: "clipboard",
    paste: "clipboard",
    cut: "clipboard",
    audio: "audio",
    speech: "audio",
    voice: "audio",
    transcript: "audio",
    transcription: "audio",
    ocr: "ocr",
    read: "ocr",
    observe: "ocr",
  };

  if (mapping[normalized]) {
    return mapping[normalized];
  }
  if (EVENT_TYPES.includes(normalized as EventType)) {
    return normalized as EventType;
  }
  return null;
}

/**
 * EN: Picks first non-empty string from a list of candidate keys.
 * @param record source record.
 * @param keys candidate field names.
 * @returns string value or undefined.
 */
function pickStringByKeys(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  const picked = pickFirstDefined(record, keys);
  if (typeof picked === "string" && picked.trim().length > 0) {
    return picked.trim();
  }
  return undefined;
}

/**
 * EN: Picks the first defined value from record by key order.
 * @param record input record.
 * @param keys candidate key order.
 * @returns matched value or undefined.
 */
function pickFirstDefined(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (key in record && record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

/**
 * EN: Reads one optional planner string-list field and preserves `undefined` when the field is absent.
 * @param record planner output object.
 * @param keys compatible field-name aliases.
 * @returns normalized list, or `undefined` when omitted.
 */
function pickOptionalNormalizedStringList(
  record: Record<string, unknown>,
  keys: string[],
): string[] | undefined {
  const fieldExists = keys.some((key) => key in record);
  if (!fieldExists) {
    return undefined;
  }
  return normalizeFlexibleStringList(pickFirstDefined(record, keys), []);
}

/**
 * EN: Returns Record view only when value is a plain object.
 * @param value unknown value.
 * @returns Record or null.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * EN: Unwraps common draft wrappers (draft/result/data/skill and similar).
 * @param rawDraft raw draft object.
 * @returns unwrapped candidate.
 */
function unwrapDraftEnvelope(rawDraft: unknown): unknown {
  const keys = [
    "draft",
    "skill",
    "result",
    "data",
    "payload",
    "response",
    "output",
  ];
  let current: unknown = rawDraft;

  for (let depth = 0; depth < 5; depth += 1) {
    const record = asRecord(current);
    if (!record) {
      return current;
    }

    let next: unknown = undefined;
    for (const key of keys) {
      const candidate = record[key];
      if (candidate && typeof candidate === "object") {
        next = candidate;
        break;
      }
    }

    if (next === undefined) {
      return current;
    }
    current = next;
  }

  return current;
}

/**
 * EN: Caps warning count to keep summary focused and readable.
 * @param warnings warning list.
 * @param warning new warning message.
 */
function pushWarning(warnings: string[], warning: string): void {
  if (warnings.length >= MAX_NORMALIZE_WARNINGS) {
    return;
  }
  warnings.push(warning);
}

/**
 * EN: Materializes final steps from LLM draft and backfills context from timeline anchors.
 * @param draftSteps LLM draft steps.
 * @param events full event list.
 * @param warnings warning accumulator.
 * @returns materialized step list.
 */
function materializeStepsFromDraft(
  draftSteps: LlmStepDraft[],
  events: NormalizedEvent[],
  warnings: string[],
): MaterializedSkillStep[] {
  const eventIndex = new Map(events.map((event) => [event.id, event]));
  const output: MaterializedSkillStep[] = [];

  for (const [index, draft] of draftSteps.entries()) {
    const instruction = normalizeText(draft.instruction);
    const intent = normalizeText(draft.intent);
    const operationApp = normalizeText(draft.operationApp);
    if (!instruction || !intent) {
      warnings.push(
        `Dropped one LLM step due to empty normalized content at index ${index}.`,
      );
      continue;
    }
    if (!operationApp) {
      warnings.push(
        `Dropped one LLM step due to empty operationApp at index ${index}.`,
      );
      continue;
    }

    const contextEvent =
      (draft.contextEventId ? eventIndex.get(draft.contextEventId) : null) ??
      events[index] ??
      events[0] ??
      null;
    const finalContextEventType = EVENT_TYPES.includes(
      draft.contextEventType ?? "ocr",
    )
      ? (draft.contextEventType ?? "ocr")
      : (contextEvent?.eventType ?? "ocr");
    const finalHints = (draft.hints ?? [])
      .map((hint) => normalizeText(hint))
      .filter((hint) => hint.length > 0)
      .slice(0, MAX_HINTS_PER_STEP);

    output.push({
      step: output.length + 1,
      instruction,
      intent,
      operationApp,
      hints: finalHints,
      contextEventType: finalContextEventType,
      contextAppName: normalizeNullableText(draft.contextAppName),
      contextWindowName: normalizeNullableText(draft.contextWindowName),
    });
  }

  return output;
}

function stripMaterializedStepContext(
  steps: MaterializedSkillStep[],
): OpenClawSkillStep[] {
  return steps.map(
    ({
      contextEventType: _contextEventType,
      contextAppName: _contextAppName,
      contextWindowName: _contextWindowName,
      ...step
    }) => step,
  );
}

/**
 * EN: Resolves final goal and replaces low-quality model output with placeholder when needed.
 * @param draftGoal LLM draft goal.
 * @param warnings warning sink.
 * @returns final goal text.
 */
function resolveGoalText(draftGoal: string, warnings: string[]): string {
  const normalizedDraftGoal = normalizeText(draftGoal ?? "");
  if (normalizedDraftGoal === MISSING_FIELD_TEXT) {
    return normalizedDraftGoal;
  }
  if (
    normalizedDraftGoal.length > 0 &&
    !isLowQualityGoal(normalizedDraftGoal)
  ) {
    return normalizedDraftGoal;
  }
  if (normalizedDraftGoal.length > 0) {
    pushWarning(warnings, "LLM goal looked noisy; used placeholder.");
  } else {
    pushWarning(warnings, "LLM output missing goal; used placeholder.");
  }
  return MISSING_FIELD_TEXT;
}

function buildSkillVariantFromDraft(input: {
  mode: SkillExecutionMode;
  baseSkillName: string;
  baseGoal: string;
  draft: LlmSkillDraft;
  steps: OpenClawSkillStep[];
  events: NormalizedEvent[];
  runId: string;
  runDir: string;
  episode: Episode;
  generatedAt: string;
  promptSet: string | null;
}): OpenClawSkill {
  const skillName = input.baseSkillName;
  const skillId = createSkillId(
    input.runId,
    input.episode.id,
    `${input.mode}:${skillName}`,
    input.generatedAt,
  );
  const goal = adjustGoalForAutonomous(input.baseGoal);

  const skill = buildSkillFromDraft({
    skillId,
    skillName,
    generatedAt: input.generatedAt,
    runId: input.runId,
    runDir: input.runDir,
    episode: input.episode,
    events: input.events,
    steps: input.steps,
    draft: {
      ...input.draft,
      prerequisites: filterAutonomousPrerequisites(input.draft.prerequisites),
    },
    goal,
    promptSet: input.promptSet,
  });

  return {
    ...skill,
    executionMode: input.mode,
  };
}

function adjustGoalForAutonomous(goal: string): string {
  const trimmed = goal.trim();
  if (!trimmed) {
    return goal;
  }
  if (/from\\s+scratch|start\\s+from\\s*(0|zero)/i.test(trimmed)) {
    return trimmed;
  }
  const cleaned = trimmed
    .replace(/currently open/gi, "target")
    .replace(/already open(?:ed)?/gi, "")
    .replace(/\bcurrent\b/gi, "target")
    .replace(/already entered/gi, "enter")
    .trim();
  return cleaned.length > 0 ? cleaned : trimmed;
}

function filterAutonomousPrerequisites(items: string[]): string[] {
  return items.filter(
    (item) =>
      !/(already open|current page|currently open|already entered|result page|details page)/i.test(
        item,
      ),
  );
}

/**
 * EN: Builds final skill object from LLM draft and run context.
 * @param input assembly input.
 * @returns OpenClaw skill object.
 */
function buildSkillFromDraft(input: {
  skillId: string;
  skillName: string;
  generatedAt: string;
  runId: string;
  runDir: string;
  episode: Episode;
  events: NormalizedEvent[];
  steps: OpenClawSkillStep[];
  draft: LlmSkillDraft;
  goal: string;
  promptSet: string | null;
}): OpenClawSkill {
  const whenToUse = normalizeStringList(input.draft.whenToUse, [
    "Use this skill when you want the AI to reproduce the task from the entry point.",
    "Use this skill when you want to distill this real interaction trace into a reusable workflow.",
  ]);
  const prerequisites = normalizeStringList(input.draft.prerequisites, [
    "Have the account, permissions, or key identifiers required to access the target system.",
    "Allow the AI to read the original context materials preserved in references.",
  ]);
  const successCriteria = normalizeStringList(input.draft.successCriteria, [
    "After completion, the interface state matches the end state of the trace.",
  ]);
  const fallback = normalizeStringList(input.draft.fallback, [
    "If a step fails, first confirm the application and window context, then retry the current step.",
  ]);
  const description =
    normalizeNullableText(input.draft.description) ?? input.goal;
  const shortDescription = buildSkillShortDescription(
    normalizeNullableText(input.draft.shortDescription) ?? description,
  );
  const whenNotToUse = normalizeStringList(input.draft.whenNotToUse, []);
  const inputs = normalizeSkillFields(input.draft.inputs);
  const outputs = normalizeSkillFields(input.draft.outputs);
  const failureModes = normalizeStringList(input.draft.failureModes, []);
  const examples = normalizeStringList(input.draft.examples, []);
  const tags = normalizeStringList(input.draft.tags, []);
  const skillAssets = normalizeSkillAssets(input.draft.assets);
  const appsSeen = collectObservedApps(input.events);
  const windowsSeen = collectObservedWindows(input.events);

  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: input.promptSet,
    skillId: input.skillId,
    skillName: input.skillName,
    generatedAt: input.generatedAt,
    source: {
      runId: input.runId,
      runDir: input.runDir,
      episodeId: input.episode.id,
      startTs: input.episode.startTs,
      endTs: input.episode.endTs,
    },
    shortDescription,
    description,
    goal: input.goal,
    whenToUse,
    whenNotToUse,
    inputs,
    outputs,
    prerequisites,
    steps: input.steps,
    successCriteria,
    failureModes,
    fallback,
    examples,
    tags,
    assets: skillAssets,
    evidence: {
      totalEvents: input.events.length,
      anchorEvents: input.events.filter((event) => event.eventType !== "ocr")
        .length,
      ocrEvents: input.events.filter((event) => event.eventType === "ocr")
        .length,
      appsSeen,
      windowsSeen,
    },
  };
}

/**
 * EN: Builds a concise summary for OpenClaw frontmatter and skill discovery.
 * @param value candidate short summary or full description.
 * @returns short summary capped at 280 chars.
 */
function buildSkillShortDescription(value: string): string {
  const normalized = normalizeText(value);
  if (normalized.length <= 280) {
    return normalized;
  }

  const sentenceBoundary = normalized.lastIndexOf(". ", 279);
  if (sentenceBoundary >= 40) {
    return normalized.slice(0, sentenceBoundary + 1).trim();
  }

  const clauseBoundary = Math.max(
    normalized.lastIndexOf("; ", 279),
    normalized.lastIndexOf(", ", 279),
  );
  if (clauseBoundary >= 40) {
    return normalized.slice(0, clauseBoundary + 1).trim();
  }

  return normalized.slice(0, 279).trimEnd() + "…";
}

function collectObservedApps(events: NormalizedEvent[]): string[] {
  return unique(
    events
      .map((event) => normalizeNullableText(event.appName))
      .filter((value): value is string => value !== null),
  );
}

function collectObservedWindows(events: NormalizedEvent[]): string[] {
  return unique(
    events
      .map((event) => normalizeNullableText(event.windowName))
      .filter((value): value is string => value !== null),
  );
}

/**
 * EN: Auto-selects episode with anchor-heavy score.
 * @param episodes candidate episodes.
 * @param episodeId optional explicit id.
 * @returns selected episode.
 */
function pickEpisode(episodes: Episode[], episodeId?: string): Episode {
  if (episodes.length === 0) {
    throw new Error("No episodes found for skill extraction.");
  }

  if (episodeId) {
    const found = episodes.find((episode) => episode.id === episodeId);
    if (!found) {
      throw new Error(`Episode not found: ${episodeId}`);
    }
    return found;
  }

  let best = episodes[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const episode of episodes) {
    const anchorCount = episode.events.filter(
      (event) => event.eventType !== "ocr",
    ).length;
    const score = anchorCount * 10_000 + episode.events.length;
    if (score > bestScore) {
      best = episode;
      bestScore = score;
    }
  }
  return best;
}

/**
 * EN: Loads episodes.json, with fallback build from normalized/events.ndjson.
 * @param runDir run directory.
 * @returns episode list.
 */
async function loadEpisodes(runDir: string): Promise<Episode[]> {
  const episodesPath = join(runDir, "episodes.json");
  try {
    const raw = await readFile(episodesPath, "utf8");
    const parsed = JSON.parse(raw) as Episode[];
    if (!Array.isArray(parsed)) {
      throw new Error("episodes.json is not an array");
    }
    if (parsed.length > 0) {
      return parsed;
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }

  const normalizedPath = join(runDir, "normalized", "events.ndjson");
  const events = await readNdjson<NormalizedEvent>(normalizedPath);
  if (events.length === 0) {
    throw new Error(`No events found in ${episodesPath} or ${normalizedPath}`);
  }

  const sorted = [...events].sort((a, b) => a.tsMs - b.tsMs);
  const fallbackRunId = basename(runDir);
  return [
    {
      id: `${fallbackRunId}-ep-0001`,
      runId: fallbackRunId,
      startTs: sorted[0].tsIso,
      endTs: sorted[sorted.length - 1].tsIso,
      durationMs: sorted[sorted.length - 1].tsMs - sorted[0].tsMs,
      eventsCount: sorted.length,
      events: sorted,
    },
  ];
}

/**
 * EN: Loads runId from manifest, fallback to directory name.
 * @param runDir run directory.
 * @param episodes loaded episodes.
 * @returns run id.
 */
async function loadRunId(runDir: string, episodes: Episode[]): Promise<string> {
  const manifestPath = join(runDir, "manifest.json");
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as RunManifest;
    if (isNonEmptyString(parsed.runId)) {
      return parsed.runId;
    }
  } catch {
    // CN/EN: fallback below.
  }

  return episodes[0]?.runId ?? basename(runDir);
}

/**
 * EN: Generates short skill id using sha1 truncation.
 * @param runId run id.
 * @param episodeId episode id.
 * @param skillName skill name.
 * @param generatedAt generation timestamp.
 * @returns skill id.
 */
function createSkillId(
  runId: string,
  episodeId: string,
  skillName: string,
  generatedAt: string,
): string {
  const seed = `${runId}|${episodeId}|${skillName}|${generatedAt}`;
  return createHash("sha1").update(seed).digest("hex").slice(0, 16);
}

/**
 * EN: Generates skill name (provided name first, else dominant app + date).
 * @param providedName user-provided name.
 * @param events event list.
 * @param episode selected episode.
 * @returns skill name.
 */
function buildSkillName(
  providedName: string | undefined,
  events: NormalizedEvent[],
  episode: Episode,
): string {
  const custom = providedName?.trim();
  if (custom) {
    return custom;
  }

  const app = pickDominantValue(events.map((event) => event.appName));
  const date = episode.startTs.slice(0, 10);
  if (app) {
    return `${app} Daily Workflow Skill (${date})`;
  }
  return `Generic Workflow Skill (${date})`;
}

/**
 * EN: Extracts a readable topic snippet from raw text for goal wording.
 * @param rawText raw text.
 * @returns readable topic snippet.
 */
function extractGoalTopic(rawText: string): string {
  const normalized = normalizeText(rawText);
  if (!normalized) {
    return "";
  }
  const firstSentence =
    normalized
      .split(/[.!?\n]/)
      .find((part) => normalizeText(part).length > 0) ?? normalized;
  const cleaned = normalizeText(
    firstSentence.replace(/[^\w\s\u4e00-\u9fa5:/.-]+/g, " "),
  );
  if (!cleaned) {
    return "";
  }
  return truncate(cleaned, 72);
}

/**
 * EN: Detects low-quality goal text (too short/template/log-centric).
 * @param goal candidate goal.
 * @returns true when replacement is recommended.
 */
function isLowQualityGoal(goal: string): boolean {
  const normalized = normalizeText(goal);
  if (normalized.length < 8) {
    return true;
  }

  const templatePatterns = [
    /complete the related workflow/i,
    /reusable workflow/i,
    /advance the current task flow/i,
    /in the .* complete/i,
  ];
  if (templatePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (/[+*#>@]{3,}/.test(normalized)) {
    return true;
  }
  if (/\b[a-z]?calhost\b/i.test(normalized)) {
    return true;
  }
  if (
    /\/[A-Za-z0-9._-]{2,}/.test(normalized) &&
    /[^\u4E00-\u9FA5A-Za-z0-9\s]{4,}/.test(normalized)
  ) {
    return true;
  }

  const quotedTopic = normalized.match(/[“"]([^”"]+)[”"]/)?.[1];
  if (quotedTopic && extractGoalTopic(quotedTopic).length === 0) {
    return true;
  }
  return false;
}

/**
 * EN: Reads NDJSON file into object array.
 * @param filePath file path.
 * @returns parsed list.
 */
async function readNdjson<T>(filePath: string): Promise<T[]> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line, idx) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(
        `Invalid NDJSON at ${filePath}:${idx + 1}: ${toErrorMessage(error)}`,
      );
    }
  });
}

/**
 * EN: Normalizes string list (trim + non-empty + unique), fallback to defaults when empty.
 * @param values input list.
 * @param fallback fallback list.
 * @returns normalized list.
 */
function normalizeStringList(
  values: string[] | undefined,
  fallback: string[],
): string[] {
  const normalized = unique(
    (values ?? [])
      .map((item) => normalizeText(item))
      .filter((item) => item.length > 0),
  );
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeSkillFields(
  values: OpenClawSkillField[] | undefined,
): OpenClawSkillField[] {
  if (!values || values.length === 0) {
    return [];
  }

  const deduped = new Map<string, OpenClawSkillField>();
  for (const value of values) {
    const name = normalizeText(value.name);
    if (name.length === 0) {
      continue;
    }
    const description = normalizeText(value.description);
    const key = `${name.toLowerCase()}::${description.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, {
        name,
        description,
        ...(value.required === undefined ? {} : { required: value.required }),
      });
    }
  }
  return [...deduped.values()];
}

function normalizeSkillAssets(
  values: OpenClawSkillAsset[] | undefined,
): OpenClawSkillAsset[] {
  if (!values || values.length === 0) {
    return [];
  }

  const deduped = new Map<string, OpenClawSkillAsset>();
  for (const value of values) {
    const name = normalizeText(value.name);
    if (name.length === 0) {
      continue;
    }
    const normalizedValue = normalizeSkillAssetValue(value.value);
    if (normalizedValue === null) {
      continue;
    }
    const notes = normalizeNullableText(value.notes);
    const normalized: OpenClawSkillAsset = {
      name,
      value: normalizedValue,
      ...(notes ? { notes } : {}),
    };
    const key = `${name.toLowerCase()}::${JSON.stringify(normalizedValue)}`;
    if (!deduped.has(key)) {
      deduped.set(key, normalized);
    }
  }
  return [...deduped.values()];
}

/**
 * EN: Picks dominant non-empty string value.
 * @param values candidate values.
 * @returns dominant value or null.
 */
function pickDominantValue(values: Array<string | null>): string | null {
  const counter = new Map<string, number>();
  for (const value of values) {
    if (!isNonEmptyString(value)) {
      continue;
    }
    counter.set(value, (counter.get(value) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = -1;
  for (const [value, count] of counter.entries()) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * EN: Normalizes whitespace.
 * @param value raw text.
 * @returns normalized text.
 */
function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * EN: Normalizes nullable string; blank text is treated as null.
 * @param value raw nullable string.
 * @returns normalized string or null.
 */
function normalizeNullableText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
}

/**
 * EN: Truncates text with ellipsis.
 * @param value source text.
 * @param maxLength max length.
 * @returns truncated text.
 */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

/**
 * EN: Deduplicates array while preserving first-seen order.
 * @param values input array.
 * @returns unique array.
 */
function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function sanitizeScenarioIdentifier(value: string): string {
  const normalized = normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "scenario";
}

/**
 * EN: Type guard for non-empty string.
 * @param value value to test.
 * @returns true if non-empty string.
 */
function isNonEmptyString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * EN: Writes JSON file with trailing newline.
 * @param path file path.
 * @param value value to write.
 * @returns resolves after write.
 */
async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * EN: Converts unknown error to string.
 * @param error error value.
 * @returns string error message.
 */
function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const causeObject = cause as {
        message?: unknown;
        code?: unknown;
        errno?: unknown;
        address?: unknown;
        port?: unknown;
      };
      const fields: string[] = [];
      if (typeof causeObject.code === "string") {
        fields.push(`code=${causeObject.code}`);
      }
      if (typeof causeObject.errno === "number") {
        fields.push(`errno=${causeObject.errno}`);
      }
      if (typeof causeObject.address === "string") {
        fields.push(`address=${causeObject.address}`);
      }
      if (typeof causeObject.port === "number") {
        fields.push(`port=${causeObject.port}`);
      }
      const causeMessage =
        typeof causeObject.message === "string" &&
        causeObject.message.length > 0
          ? causeObject.message
          : fields.join(" ");
      if (causeMessage.length > 0) {
        return `${error.message} (cause: ${causeMessage})`;
      }
    }
    return error.message;
  }
  return String(error);
}

/**
 * EN: Async sleep helper for retry backoff.
 * @param ms duration in milliseconds.
 * @returns resolves after duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
