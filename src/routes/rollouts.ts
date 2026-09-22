// Start and inspect canary rollouts. Starting one kicks off a durable
// Workflow (src/workflows/rollout.ts) that owns the phase progression, gate
// checks, and auto-rollback from here on — this route just creates the
// rollout row and the Workflow instance, then gets out of the way.

import { Hono } from "hono";
import type { Env } from "../types";
import { newId } from "../lib/ids";
import { rowToRollout } from "../lib/db";

const app = new Hono<{ Bindings: Env }>();

app.post("/", async (c) => {
	const promptId = c.req.param("promptId") as string;
	const body = await c.req.json<{ candidateVersionId: string }>();

	const prompt = await c.env.DB.prepare(`SELECT id FROM prompts WHERE id = ?`).bind(promptId).first();
	if (!prompt) return c.json({ error: "prompt not found" }, 404);

	const candidate = await c.env.DB.prepare(`SELECT id FROM versions WHERE id = ? AND prompt_id = ?`)
		.bind(body.candidateVersionId, promptId)
		.first();
	if (!candidate) return c.json({ error: "candidate version not found for this prompt" }, 404);

	const stub = c.env.PROMPT.get(c.env.PROMPT.idFromName(promptId));
	const routing = await stub.getRouting();
	if (!routing) return c.json({ error: "prompt has no active deployment to canary against" }, 400);
	if (routing.rolloutId) return c.json({ error: "a rollout is already running for this prompt" }, 409);

	// Baseline = whatever is currently serving 100% (the highest-traffic
	// entry in the current routing config).
	const baseline = [...routing.config].sort((a, b) => b.traffic - a.traffic)[0]!;
	if (baseline.versionId === body.candidateVersionId) {
		return c.json({ error: "candidate is already the active baseline" }, 400);
	}

	const rolloutId = newId("roll");
	const now = Date.now();

	await c.env.DB.prepare(
		`INSERT INTO rollouts (id, prompt_id, candidate_version_id, baseline_version_id, status, phase, workflow_id, started_at)
		 VALUES (?, ?, ?, ?, 'running', 0, ?, ?)`,
	)
		.bind(rolloutId, promptId, body.candidateVersionId, baseline.versionId, rolloutId, now)
		.run();

	await c.env.ROLLOUT.create({
		id: rolloutId,
		params: {
			promptId,
			rolloutId,
			candidateVersionId: body.candidateVersionId,
			baselineVersionId: baseline.versionId,
		},
	});

	return c.json({ rolloutId }, 201);
});

app.get("/", async (c) => {
	const promptId = c.req.param("promptId") as string;
	const { results } = await c.env.DB.prepare(
		`SELECT * FROM rollouts WHERE prompt_id = ? ORDER BY started_at DESC LIMIT 20`,
	)
		.bind(promptId)
		.all();
	return c.json({ rollouts: results.map(rowToRollout) });
});

app.get("/:rolloutId", async (c) => {
	const { rolloutId } = c.req.param();
	const row = await c.env.DB.prepare(`SELECT * FROM rollouts WHERE id = ?`).bind(rolloutId).first();
	if (!row) return c.json({ error: "not found" }, 404);

	const instance = await c.env.ROLLOUT.get(rolloutId);
	const workflowStatus = await instance.status().catch(() => null);

	return c.json({ rollout: rowToRollout(row), workflowStatus });
});

export default app;
