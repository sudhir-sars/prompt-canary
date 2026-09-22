// Thin row<->type mapping helpers for D1. Kept separate from route handlers
// so the SQL shape (snake_case, JSON-encoded config) doesn't leak everywhere.

import type { Deployment, DeploymentReason, PromptVersion, Rollout, RolloutStatus } from "../types";

export function rowToVersion(r: Record<string, unknown>): PromptVersion {
	return {
		id: r.id as string,
		promptId: r.prompt_id as string,
		sequence: r.sequence as number,
		content: r.content as string,
		note: (r.note as string | null) ?? null,
		createdAt: r.created_at as number,
	};
}

export function rowToDeployment(r: Record<string, unknown>): Deployment {
	return {
		id: r.id as string,
		promptId: r.prompt_id as string,
		config: JSON.parse(r.config as string),
		reason: r.reason as DeploymentReason,
		rolledBackTo: (r.rolled_back_to as string | null) ?? null,
		rolloutId: (r.rollout_id as string | null) ?? null,
		createdAt: r.created_at as number,
	};
}

export function rowToRollout(r: Record<string, unknown>): Rollout {
	return {
		id: r.id as string,
		promptId: r.prompt_id as string,
		candidateVersionId: r.candidate_version_id as string,
		baselineVersionId: r.baseline_version_id as string,
		status: r.status as RolloutStatus,
		phase: r.phase as number,
		workflowId: (r.workflow_id as string | null) ?? null,
		outcomeReason: (r.outcome_reason as string | null) ?? null,
		startedAt: r.started_at as number,
		endedAt: (r.ended_at as number | null) ?? null,
	};
}
