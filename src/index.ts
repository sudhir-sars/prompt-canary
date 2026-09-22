import { Hono } from "hono";
import type { Env } from "./types";
import prompts from "./routes/prompts";
import rollouts from "./routes/rollouts";
import chat from "./routes/chat";

// Cloudflare requires the DO and Workflow classes to be exported from the
// entrypoint module named in wrangler.jsonc's `class_name` fields.
export { PromptDO } from "./do/prompt-do";
export { RolloutWorkflow } from "./workflows/rollout";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
	console.error("[worker] Unhandled error:", err);
	return c.json({ error: "internal server error" }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true }));

// POST /api/chat/:promptId — playground turns; generates + judges + records.
app.route("/api/chat", chat);

// /api/prompts/:promptId/rollouts/* — canary start + status.
app.route("/api/prompts/:promptId/rollouts", rollouts);

// /api/prompts, /api/prompts/:promptId, /api/prompts/:promptId/versions,
// /api/prompts/:promptId/deploy — CRUD + immutable version history.
app.route("/api/prompts", prompts);

// Everything else falls through to the static playground UI.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
