// The playground. Every turn here does three things:
//   1. picks a version per the prompt's current traffic split (DO)
//   2. generates a reply with it, and judges that reply (Workers AI, x2)
//   3. records the resulting sample into the DO's rolling window + D1's
//      permanent eval_events log
//
// This is the data source the SLO gate in the Workflow reads from — chat
// traffic literally *is* the canary's test traffic, not a separate harness.

import { Hono } from "hono";
import type { Env } from "../types";
import { newId } from "../lib/ids";
import { runChatTurn, runJudge } from "../lib/ai";

const app = new Hono<{ Bindings: Env }>();

app.post("/:promptId", async (c) => {
	const promptId = c.req.param("promptId") as string;
	const body = await c.req.json<{ message: string; sessionId?: string }>();
	if (!body.message?.trim()) return c.json({ error: "message is required" }, 400);

	const sessionId = body.sessionId?.trim() || newId("sess");

	const stub = c.env.PROMPT.get(c.env.PROMPT.idFromName(promptId));
	const versionId = await stub.pickVersion();
	if (!versionId) return c.json({ error: "prompt has no active deployment" }, 400);

	const routing = await stub.getRouting();

	const versionRow = await c.env.DB.prepare(`SELECT content FROM versions WHERE id = ?`)
		.bind(versionId)
		.first<{ content: string }>();
	if (!versionRow) return c.json({ error: "routed version no longer exists" }, 500);

	const turn = await runChatTurn(c.env, versionRow.content, body.message);
	const judge = turn.ok
		? await runJudge(c.env, versionRow.content, body.message, turn.content)
		: { ok: false, relevance: null, instruction: null, compositeScore: null, note: null };

	const now = Date.now();
	const eventId = newId("eval");

	await Promise.all([
		stub.recordSample({
			versionId,
			rolloutId: routing?.rolloutId ?? null,
			ok: turn.ok,
			schemaValid: turn.schemaValid,
			latencyMs: turn.latencyMs,
			judgeScore: judge.compositeScore,
			ts: now,
		}),
		c.env.DB.prepare(
			`INSERT INTO eval_events
			 (id, prompt_id, version_id, rollout_id, session_id, created_at, ok, error_kind, latency_ms, schema_valid, judge_score, relevance, instruction, judge_note)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				eventId,
				promptId,
				versionId,
				routing?.rolloutId ?? null,
				sessionId,
				now,
				turn.ok ? 1 : 0,
				turn.errorKind,
				turn.latencyMs,
				turn.schemaValid ? 1 : 0,
				judge.compositeScore,
				judge.relevance,
				judge.instruction,
				judge.note,
			)
			.run(),
	]);

	return c.json({
		sessionId,
		versionId,
		reply: turn.ok ? turn.content : `(error: ${turn.errorKind})`,
		eval: {
			ok: turn.ok,
			schemaValid: turn.schemaValid,
			latencyMs: turn.latencyMs,
			relevance: judge.relevance,
			instruction: judge.instruction,
			compositeScore: judge.compositeScore,
			note: judge.note,
		},
	});
});

export default app;
