import { describe, expect, it } from "vitest";
import { evaluateSlo, type WindowRow } from "../src/lib/slo";
import { DEFAULT_SLO, MIN_SAMPLES_PER_PHASE } from "../src/types";

function sample(overrides: Partial<WindowRow> = {}): WindowRow {
	return { ok: true, schemaValid: true, latencyMs: 500, judgeScore: 0.9, ...overrides };
}

describe("evaluateSlo", () => {
	it("passes a healthy window with no breaches", () => {
		const rows = Array.from({ length: 10 }, () => sample());
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.pass).toBe(true);
		expect(verdict.breaches).toEqual([]);
		expect(verdict.sampleCount).toBe(10);
		expect(verdict.metrics.errorRate).toBe(0);
		expect(verdict.metrics.schemaValidRate).toBe(1);
	});

	it("treats too few samples as an inconclusive pass, not a failure", () => {
		const rows = Array.from({ length: MIN_SAMPLES_PER_PHASE - 1 }, () => sample());
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.pass).toBe(true);
		expect(verdict.breaches).toEqual(["insufficient_samples"]);
	});

	it("fails on an error rate above the threshold", () => {
		const rows = [
			...Array.from({ length: 8 }, () => sample({ ok: true })),
			...Array.from({ length: 2 }, () => sample({ ok: false })), // 20% > 15% max
		];
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.pass).toBe(false);
		expect(verdict.breaches[0]).toMatch(/^error_rate/);
		expect(verdict.metrics.errorRate).toBeCloseTo(0.2);
	});

	it("fails on a schema-valid rate below the threshold", () => {
		const rows = [
			...Array.from({ length: 5 }, () => sample({ schemaValid: true })),
			...Array.from({ length: 5 }, () => sample({ schemaValid: false })), // 50% < 90% min
		];
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.pass).toBe(false);
		expect(verdict.breaches.some((b) => b.startsWith("schema_valid_rate"))).toBe(true);
	});

	it("fails on p95 latency above the threshold, using the 95th-percentile sample not the max", () => {
		// 19 samples at 100ms, 1 outlier at 50,000ms (20 total). p95 index =
		// min(19, floor(20*0.95)) = 19 — the last, sorted-highest sample, i.e.
		// the outlier itself.
		const rows = [...Array.from({ length: 19 }, () => sample({ latencyMs: 100 })), sample({ latencyMs: 50_000 })];
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.metrics.p95LatencyMs).toBe(50_000);
		expect(verdict.pass).toBe(false);
		expect(verdict.breaches.some((b) => b.startsWith("p95_latency"))).toBe(true);
	});

	it("does not let one slow outlier alone breach p95 when the window is large enough", () => {
		// 99 fast samples + 1 slow one: p95 index lands on a fast sample.
		const rows = [...Array.from({ length: 99 }, () => sample({ latencyMs: 100 })), sample({ latencyMs: 50_000 })];
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.metrics.p95LatencyMs).toBe(100);
		expect(verdict.pass).toBe(true);
	});

	it("fails on a mean judge score below the threshold", () => {
		const rows = Array.from({ length: 10 }, () => sample({ judgeScore: 0.2 })); // < 0.6 min
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.pass).toBe(false);
		expect(verdict.breaches.some((b) => b.startsWith("judge_score"))).toBe(true);
	});

	it("excludes null judge scores (judge failures) from the mean rather than counting them as 0", () => {
		const rows = [
			...Array.from({ length: 5 }, () => sample({ judgeScore: 0.9 })),
			...Array.from({ length: 5 }, () => sample({ judgeScore: null })), // judge itself failed
		];
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.metrics.meanJudgeScore).toBeCloseTo(0.9);
		expect(verdict.pass).toBe(true);
	});

	it("reports multiple simultaneous breaches", () => {
		const rows = Array.from({ length: 10 }, () =>
			sample({ ok: false, schemaValid: false, latencyMs: 20_000, judgeScore: 0.1 }),
		);
		const verdict = evaluateSlo(rows, DEFAULT_SLO);

		expect(verdict.pass).toBe(false);
		expect(verdict.breaches.length).toBe(4);
	});
});
