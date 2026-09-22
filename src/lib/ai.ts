// The two distinct LLM roles in this system: generating a chat reply, and
// judging one. Both currently run the same model (Llama 3.3), but they are
// kept as separate functions with separate prompts/contracts because in a
// real deployment you'd often want a cheaper/different model for the judge.

import type { Env } from "../types";

export interface ChatTurnResult {
	ok: boolean;
	content: string;
	errorKind: string | null;
	latencyMs: number;
	schemaValid: boolean;
}

export interface JudgeResult {
	ok: boolean;
	relevance: number | null; // 1-5
	instruction: number | null; // 1-5
	compositeScore: number | null; // 0-1
	note: string | null;
}

// Response contract the candidate prompt must obey: a JSON object with a
// single "reply" string field. This gives us a cheap, objective
// "schema_valid" signal alongside the subjective judge score.
const OUTPUT_CONTRACT =
	'Respond ONLY with a JSON object of the exact shape {"reply": string}. No prose outside the JSON.';

export async function runChatTurn(
	env: Env,
	systemPrompt: string,
	userMessage: string,
): Promise<ChatTurnResult> {
	const start = Date.now();
	try {
		const result = await env.AI.run(env.CHAT_MODEL as keyof AiModels, {
			messages: [
				{ role: "system", content: `${systemPrompt}\n\n${OUTPUT_CONTRACT}` },
				{ role: "user", content: userMessage },
			],
			max_tokens: 512,
			temperature: 0.7,
		} as never);

		const latencyMs = Date.now() - start;
		// Workers AI has been observed to sometimes auto-parse a model's JSON
		// output into an object on `response` rather than leaving it as a raw
		// string (undocumented, model/runtime-dependent). Handle both shapes.
		const responseField = (result as { response?: unknown }).response;
		const raw = typeof responseField === "string" ? responseField : JSON.stringify(responseField ?? "");

		const parsed = tryParseReply(raw);
		if (parsed === null) {
			// Model ignored the contract. This is a real, measurable failure
			// mode for a prompt change, not a plumbing error, so it's surfaced
			// as schemaValid=false rather than thrown.
			return { ok: true, content: raw, errorKind: null, latencyMs, schemaValid: false };
		}

		return { ok: true, content: parsed, errorKind: null, latencyMs, schemaValid: true };
	} catch (err) {
		return {
			ok: false,
			content: "",
			errorKind: err instanceof Error ? err.message.slice(0, 200) : "unknown_error",
			latencyMs: Date.now() - start,
			schemaValid: false,
		};
	}
}

export function tryParseReply(raw: string): string | null {
	try {
		// Models sometimes wrap JSON in a code fence despite instructions.
		const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
		const obj = JSON.parse(cleaned);
		if (obj && typeof obj === "object" && typeof obj.reply === "string") {
			return obj.reply;
		}
		return null;
	} catch {
		return null;
	}
}

const JUDGE_SYSTEM = `You are a strict evaluator of AI assistant replies. Score the reply on:
- relevance: does it actually address the user's message? (1-5)
- instruction: did it follow the system prompt's intent and constraints? (1-5)

Respond ONLY with JSON: {"relevance": number, "instruction": number, "note": string}
"note" is one short sentence explaining the score.`;

export async function runJudge(
	env: Env,
	systemPrompt: string,
	userMessage: string,
	candidateReply: string,
): Promise<JudgeResult> {
	try {
		const result = await env.AI.run(env.JUDGE_MODEL as keyof AiModels, {
			messages: [
				{ role: "system", content: JUDGE_SYSTEM },
				{
					role: "user",
					content: `System prompt under test:\n"""${systemPrompt}"""\n\nUser message:\n"""${userMessage}"""\n\nCandidate reply:\n"""${candidateReply}"""`,
				},
			],
			max_tokens: 200,
			temperature: 0.2,
		} as never);

		const responseField = (result as { response?: unknown }).response;
		let parsed: { relevance: number; instruction: number; note: string };
		if (typeof responseField === "string") {
			const cleaned = responseField.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
			parsed = JSON.parse(cleaned);
		} else {
			parsed = responseField as { relevance: number; instruction: number; note: string };
		}

		const relevance = clamp(parsed.relevance, 1, 5);
		const instruction = clamp(parsed.instruction, 1, 5);
		const compositeScore = (relevance - 1) / 4 * 0.5 + (instruction - 1) / 4 * 0.5;

		return { ok: true, relevance, instruction, compositeScore, note: parsed.note ?? null };
	} catch {
		// A judge failure is not scored as a candidate failure — it's excluded
		// from judge_score aggregation (see PromptDO.computeSlo) rather than
		// counted against the prompt being tested.
		return { ok: false, relevance: null, instruction: null, compositeScore: null, note: null };
	}
}

function clamp(n: number, min: number, max: number): number {
	if (Number.isNaN(n)) return min;
	return Math.min(max, Math.max(min, n));
}
