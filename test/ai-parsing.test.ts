import { describe, expect, it } from "vitest";
import { tryParseReply } from "../src/lib/ai";

// Covers the schema_valid signal's edge cases directly — this is a real
// production discovery, not a hypothetical: during manual testing against
// live Workers AI, `env.AI.run()` was observed returning `response` as an
// already-parsed object rather than a JSON string for some outputs. Both
// shapes are normalized to a string before reaching this function (see
// runChatTurn), so tryParseReply only ever sees strings — but it must
// tolerate the other real-world messiness models produce.
describe("tryParseReply", () => {
	it("parses a clean JSON object with a string reply field", () => {
		expect(tryParseReply('{"reply": "hello there"}')).toBe("hello there");
	});

	it("strips a markdown code fence around the JSON", () => {
		expect(tryParseReply('```json\n{"reply": "hi"}\n```')).toBe("hi");
		expect(tryParseReply('```\n{"reply": "hi"}\n```')).toBe("hi");
	});

	it("returns null for plain prose that ignored the contract entirely", () => {
		expect(tryParseReply("Sure, here is your answer: hello!")).toBeNull();
	});

	it("returns null for valid JSON missing the reply field", () => {
		expect(tryParseReply('{"message": "hello"}')).toBeNull();
	});

	it("returns null for valid JSON where reply is not a string", () => {
		expect(tryParseReply('{"reply": {"nested": true}}')).toBeNull();
	});

	it("returns null for malformed/truncated JSON (e.g. token-budget cutoff)", () => {
		expect(tryParseReply('{"reply": "this got cut off mid senten')).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(tryParseReply("")).toBeNull();
	});
});
