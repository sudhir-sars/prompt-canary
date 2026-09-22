// CRUD for prompts + immutable versions + manual deployments. This is the
// "version manager with immutable history" half of the assignment. The
// rollout/gating half lives in routes/rollouts.ts and the Workflow.

import { Hono } from "hono";
import type { Env } from "../types";
import { newId } from "../lib/ids";
import { rowToDeployment, rowToVersion } from "../lib/db";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
	const { results } = await c.env.DB.prepare(
		`SELECT id, name, created_at FROM prompts ORDER BY created_at DESC`,
	).all();
	return c.json({ prompts: results });
});

app.post("/", async (c) => {
	const body = await c.req.json<{ id?: string; name: string; content: string }>();
	if (!body.name?.trim() || !body.content?.trim()) {
		return c.json({ error: "name and content are required" }, 400);
	}

	const promptId = (body.id?.trim() || slugify(body.name));
	const now = Date.now();

	const existing = await c.env.DB.prepare(`SELECT id FROM prompts WHERE id = ?`).bind(promptId).first();
	if (existing) return c.json({ error: `prompt "${promptId}" already exists` }, 409);

	const versionId = newId("ver");

	await c.env.DB.batch([
		c.env.DB.prepare(`INSERT INTO prompts (id, name, created_at) VALUES (?, ?, ?)`).bind(
			promptId,
			body.name.trim(),
			now,
		),
		c.env.DB.prepare(
			`INSERT INTO versions (id, prompt_id, sequence, content, note, created_at) VALUES (?, ?, 1, ?, 'initial', ?)`,
		).bind(versionId, promptId, body.content, now),
	]);

	// Route 100% traffic to v1 immediately so the prompt is servable.
	const stub = c.env.PROMPT.get(c.env.PROMPT.idFromName(promptId));
	const deploymentId = newId("dep");
	await stub.setRouting({
		promptId,
		config: [{ versionId, traffic: 100 }],
		deploymentId,
		rolloutId: null,
	});
	await c.env.DB.prepare(
		`INSERT INTO deployments (id, prompt_id, config, reason, rolled_back_to, rollout_id, created_at)
		 VALUES (?, ?, ?, 'manual', NULL, NULL, ?)`,
	)
		.bind(deploymentId, promptId, JSON.stringify([{ versionId, traffic: 100 }]), now)
		.run();

	return c.json({ promptId, versionId }, 201);
});

app.get("/:promptId", async (c) => {
	const promptId = c.req.param("promptId") as string;
	const prompt = await c.env.DB.prepare(`SELECT id, name, created_at FROM prompts WHERE id = ?`)
		.bind(promptId)
		.first();
	if (!prompt) return c.json({ error: "not found" }, 404);

	const stub = c.env.PROMPT.get(c.env.PROMPT.idFromName(promptId));
	const routing = await stub.getRouting();

	const { results: versionRows } = await c.env.DB.prepare(
		`SELECT * FROM versions WHERE prompt_id = ? ORDER BY sequence DESC`,
	)
		.bind(promptId)
		.all();

	const { results: deploymentRows } = await c.env.DB.prepare(
		`SELECT * FROM deployments WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 20`,
	)
		.bind(promptId)
		.all();

	return c.json({
		prompt,
		routing,
		versions: versionRows.map(rowToVersion),
		deployments: deploymentRows.map(rowToDeployment),
	});
});

// Create a new immutable version. Does NOT route traffic to it — that only
// happens via a manual deploy or a rollout (routes/rollouts.ts).
app.post("/:promptId/versions", async (c) => {
	const promptId = c.req.param("promptId") as string;
	const body = await c.req.json<{ content: string; note?: string }>();
	if (!body.content?.trim()) return c.json({ error: "content is required" }, 400);

	const prompt = await c.env.DB.prepare(`SELECT id FROM prompts WHERE id = ?`).bind(promptId).first();
	if (!prompt) return c.json({ error: "not found" }, 404);

	const last = await c.env.DB.prepare(
		`SELECT MAX(sequence) as maxSeq FROM versions WHERE prompt_id = ?`,
	)
		.bind(promptId)
		.first<{ maxSeq: number }>();

	const sequence = (last?.maxSeq ?? 0) + 1;
	const versionId = newId("ver");
	const now = Date.now();

	await c.env.DB.prepare(
		`INSERT INTO versions (id, prompt_id, sequence, content, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(versionId, promptId, sequence, body.content, body.note ?? null, now)
		.run();

	return c.json({ versionId, sequence }, 201);
});

// Deploy a version at 100% immediately, bypassing the canary. Used for the
// very first deploy, or a deliberate "just ship it" override.
app.post("/:promptId/deploy", async (c) => {
	const promptId = c.req.param("promptId") as string;
	const body = await c.req.json<{ versionId: string }>();

	const version = await c.env.DB.prepare(`SELECT id FROM versions WHERE id = ? AND prompt_id = ?`)
		.bind(body.versionId, promptId)
		.first();
	if (!version) return c.json({ error: "version not found for this prompt" }, 404);

	const stub = c.env.PROMPT.get(c.env.PROMPT.idFromName(promptId));
	const deploymentId = newId("dep");
	const now = Date.now();
	const config = [{ versionId: body.versionId, traffic: 100 }];

	await stub.setRouting({ promptId, config, deploymentId, rolloutId: null });
	await c.env.DB.prepare(
		`INSERT INTO deployments (id, prompt_id, config, reason, rolled_back_to, rollout_id, created_at)
		 VALUES (?, ?, ?, 'manual', NULL, NULL, ?)`,
	)
		.bind(deploymentId, promptId, JSON.stringify(config), now)
		.run();

	return c.json({ deploymentId });
});

function slugify(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/(^-|-$)/g, "") || newId("prompt")
	);
}

export default app;
