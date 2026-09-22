// Pure SLO evaluation, factored out of PromptDO so it's testable without a
// Durable Object runtime. PromptDO.computeSlo is a thin wrapper: it reads
// rows out of SQLite and hands them to evaluateSlo below.

import type { SloThresholds, SloVerdict } from "../types";
import { MIN_SAMPLES_PER_PHASE } from "../types";

export interface WindowRow {
	ok: boolean;
	schemaValid: boolean;
	latencyMs: number;
	judgeScore: number | null;
}

export function evaluateSlo(rows: WindowRow[], thresholds: SloThresholds): SloVerdict {
	const sampleCount = rows.length;

	if (sampleCount < MIN_SAMPLES_PER_PHASE) {
		// Not enough traffic hit the candidate this phase to judge it either
		// way. Treated as a pass rather than a failure: rolling back a
		// perfectly good prompt because low-percentage traffic produced too
		// few samples would be worse than proceeding on thin evidence and
		// catching real problems at the next, larger phase.
		return {
			pass: true,
			sampleCount,
			breaches: ["insufficient_samples"],
			metrics: { meanJudgeScore: null, errorRate: 0, p95LatencyMs: 0, schemaValidRate: 0 },
		};
	}

	const errorRate = rows.filter((r) => !r.ok).length / sampleCount;
	const schemaValidRate = rows.filter((r) => r.schemaValid).length / sampleCount;
	const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
	const p95LatencyMs = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]!;

	const judgeScores = rows.map((r) => r.judgeScore).filter((s): s is number => s !== null);
	const meanJudgeScore =
		judgeScores.length > 0 ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length : null;

	const breaches: string[] = [];
	if (errorRate > thresholds.maxErrorRate) breaches.push(`error_rate ${(errorRate * 100).toFixed(0)}%`);
	if (schemaValidRate < thresholds.minSchemaValidRate)
		breaches.push(`schema_valid_rate ${(schemaValidRate * 100).toFixed(0)}%`);
	if (p95LatencyMs > thresholds.maxP95LatencyMs) breaches.push(`p95_latency ${p95LatencyMs}ms`);
	if (meanJudgeScore !== null && meanJudgeScore < thresholds.minJudgeScore)
		breaches.push(`judge_score ${meanJudgeScore.toFixed(2)}`);

	return {
		pass: breaches.length === 0,
		sampleCount,
		breaches,
		metrics: { meanJudgeScore, errorRate, p95LatencyMs, schemaValidRate },
	};
}
