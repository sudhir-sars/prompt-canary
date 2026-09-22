// One PromptDO instance per prompt (idFromName(promptId)). This is the
// single-writer arbiter for two things that must never race:
//   1. which version(s) are currently receiving traffic, and at what split
//   2. the rolling window of eval events used to gate/rollback a rollout
//
// D1 holds the permanent, queryable history (versions, deployments,
// rollouts, every eval event ever recorded). This DO holds only the live,
// hot state needed to route the next request and decide the next gate —
// a bounded in-memory/SQLite window, not the source of truth for history.

import { DurableObject } from "cloudflare:workers";
import type { DeployConfigEntry, Env, SloThresholds, SloVerdict } from "../types";
import { DEFAULT_SLO } from "../types";
import { evaluateSlo } from "../lib/slo";
import { pickWeightedVersion } from "../lib/traffic";

interface RoutingState {
	promptId: string;
	config: DeployConfigEntry[]; // sums to 100
	deploymentId: string;
	rolloutId: string | null;
}

interface WindowSample {
	versionId: string;
	rolloutId: string | null;
	ok: boolean;
	schemaValid: boolean;
	latencyMs: number;
	judgeScore: number | null;
	ts: number;
}

const WINDOW_MAX_SAMPLES = 200; // per prompt, bounded so the DO never grows unbounded

export class PromptDO extends DurableObject<Env> {
	sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS routing (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				state TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS window_samples (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				version_id TEXT NOT NULL,
				rollout_id TEXT,
				ok INTEGER NOT NULL,
				schema_valid INTEGER NOT NULL,
				latency_ms INTEGER NOT NULL,
				judge_score REAL,
				ts INTEGER NOT NULL
			);
		`);
	}

	// --- Routing config ---------------------------------------------------

	async setRouting(state: RoutingState): Promise<void> {
		this.sql.exec(`DELETE FROM routing WHERE id = 1`);
		this.sql.exec(`INSERT INTO routing (id, state) VALUES (1, ?)`, JSON.stringify(state));
	}

	async getRouting(): Promise<RoutingState | null> {
		const row = [...this.sql.exec(`SELECT state FROM routing WHERE id = 1`)][0] as
			| { state: string }
			| undefined;
		return row ? (JSON.parse(row.state) as RoutingState) : null;
	}

	// Atomically claim the right to start a rollout, or refuse if one is
	// already running. This MUST be a single DO call rather than
	// "getRouting() then check in the Worker" — Durable Objects process one
	// request at a time (the input gate serializes concurrent calls to the
	// same instance), so doing the check-and-set here closes the race that a
	// check-then-act split across an await in the Worker cannot. Sets
	// rolloutId immediately (before the Workflow's first phase step even
	// runs) precisely so a second concurrent call sees it right away.
	async reserveRollout(rolloutId: string): Promise<{ ok: boolean; routing: RoutingState | null }> {
		const state = await this.getRouting();
		if (!state) return { ok: false, routing: null };
		if (state.rolloutId) return { ok: false, routing: state };

		const reserved: RoutingState = { ...state, rolloutId };
		await this.setRouting(reserved);
		return { ok: true, routing: state }; // return the PRE-reservation state so the caller has the real baseline config
	}

	// Release a reservation if the Workflow never actually got created
	// (e.g. env.ROLLOUT.create() throws after reserveRollout succeeded).
	// Without this, a failed rollout start would leave the prompt
	// permanently unable to start another rollout.
	async releaseRollout(rolloutId: string): Promise<void> {
		const state = await this.getRouting();
		if (state && state.rolloutId === rolloutId) {
			await this.setRouting({ ...state, rolloutId: null });
		}
	}

	// Weighted-random variant pick. (promptX used a sticky SHA-256 bucket by
	// session; this demo favors always-fresh sampling so the canary's traffic
	// share is visible turn-by-turn in the UI. Both are legitimate choices —
	// noted in the README rather than left silently different.)
	async pickVersion(): Promise<string | null> {
		const state = await this.getRouting();
		if (!state) return null;
		return pickWeightedVersion(state.config, Math.random() * 100);
	}

	// --- Eval window --------------------------------------------------------

	async recordSample(sample: WindowSample): Promise<void> {
		this.sql.exec(
			`INSERT INTO window_samples (version_id, rollout_id, ok, schema_valid, latency_ms, judge_score, ts)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			sample.versionId,
			sample.rolloutId,
			sample.ok ? 1 : 0,
			sample.schemaValid ? 1 : 0,
			sample.latencyMs,
			sample.judgeScore,
			sample.ts,
		);
		// Trim to the last WINDOW_MAX_SAMPLES rows total (cheap, bounded table).
		this.sql.exec(
			`DELETE FROM window_samples WHERE seq NOT IN (
				SELECT seq FROM window_samples ORDER BY seq DESC LIMIT ?
			)`,
			WINDOW_MAX_SAMPLES,
		);
	}

	// Compute the SLO verdict for a specific version, over samples recorded
	// since `sinceTs`. Called by the Workflow after each bake window.
	async computeSlo(
		versionId: string,
		sinceTs: number,
		thresholds: SloThresholds = DEFAULT_SLO,
	): Promise<SloVerdict> {
		const rows = [
			...this.sql.exec(
				`SELECT ok, schema_valid, latency_ms, judge_score FROM window_samples
				 WHERE version_id = ? AND ts >= ? ORDER BY seq ASC`,
				versionId,
				sinceTs,
			),
		] as { ok: number; schema_valid: number; latency_ms: number; judge_score: number | null }[];

		return evaluateSlo(
			rows.map((r) => ({
				ok: r.ok === 1,
				schemaValid: r.schema_valid === 1,
				latencyMs: r.latency_ms,
				judgeScore: r.judge_score,
			})),
			thresholds,
		);
	}

	async recentSamples(versionId: string, limit = 50) {
		return [
			...this.sql.exec(
				`SELECT version_id, ok, schema_valid, latency_ms, judge_score, ts FROM window_samples
				 WHERE version_id = ? ORDER BY seq DESC LIMIT ?`,
				versionId,
				limit,
			),
		];
	}
}
