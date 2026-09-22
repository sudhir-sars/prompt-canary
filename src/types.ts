// Shared types across Worker, Durable Object, and Workflow.

import type { PromptDO } from "./do/prompt-do";
import type { RolloutParams } from "./workflows/rollout";

export interface Env {
	ASSETS: Fetcher;
	AI: Ai;
	DB: D1Database;
	PROMPT: DurableObjectNamespace<PromptDO>;
	ROLLOUT: Workflow<RolloutParams>;
	JUDGE_MODEL: string;
	CHAT_MODEL: string;
}

export interface PromptVersion {
	id: string;
	promptId: string;
	sequence: number;
	content: string;
	note: string | null;
	createdAt: number;
}

export interface DeployConfigEntry {
	versionId: string;
	traffic: number; // 0-100, entries sum to 100
}

export type DeploymentReason = "manual" | "rollout_phase" | "auto_rollback" | "promote";

export interface Deployment {
	id: string;
	promptId: string;
	config: DeployConfigEntry[];
	reason: DeploymentReason;
	rolledBackTo: string | null;
	rolloutId: string | null;
	createdAt: number;
}

export type RolloutStatus = "running" | "promoted" | "rolled_back" | "aborted";

export interface Rollout {
	id: string;
	promptId: string;
	candidateVersionId: string;
	baselineVersionId: string;
	status: RolloutStatus;
	phase: number;
	workflowId: string | null;
	outcomeReason: string | null;
	startedAt: number;
	endedAt: number | null;
}

export interface EvalEvent {
	id: string;
	promptId: string;
	versionId: string;
	rolloutId: string | null;
	sessionId: string;
	createdAt: number;
	ok: boolean;
	errorKind: string | null;
	latencyMs: number;
	schemaValid: boolean;
	judgeScore: number | null;
	relevance: number | null;
	instruction: number | null;
	judgeNote: string | null;
}

// The rollout phases a canary walks through before full promotion, each
// with a bake window the workflow sleeps through before the next gate check.
export const ROLLOUT_PHASES = [5, 25, 50, 100] as const;
export const PHASE_BAKE_MS = 90_000; // 90s per phase in the demo; real deployments would use minutes/hours
export const MIN_SAMPLES_PER_PHASE = 5; // don't gate on statistical noise

// SLO thresholds the DO evaluates after each bake window.
export interface SloThresholds {
	minJudgeScore: number; // composite 0-1
	maxErrorRate: number; // 0-1
	maxP95LatencyMs: number;
	minSchemaValidRate: number; // 0-1
}

export const DEFAULT_SLO: SloThresholds = {
	minJudgeScore: 0.6,
	maxErrorRate: 0.15,
	maxP95LatencyMs: 8_000,
	minSchemaValidRate: 0.9,
};

export interface SloVerdict {
	pass: boolean;
	sampleCount: number;
	breaches: string[];
	metrics: {
		meanJudgeScore: number | null;
		errorRate: number;
		p95LatencyMs: number;
		schemaValidRate: number;
	};
}
