import { describe, expect, it } from "vitest";
import { pickWeightedVersion } from "../src/lib/traffic";

describe("pickWeightedVersion", () => {
	it("returns null for an empty config", () => {
		expect(pickWeightedVersion([], 50)).toBeNull();
	});

	it("always returns the single entry when there is only one", () => {
		const config = [{ versionId: "v1", traffic: 100 }];
		expect(pickWeightedVersion(config, 0)).toBe("v1");
		expect(pickWeightedVersion(config, 99.9)).toBe("v1");
	});

	it("routes to the candidate below its cumulative boundary, baseline above it", () => {
		const config = [
			{ versionId: "candidate", traffic: 5 },
			{ versionId: "baseline", traffic: 95 },
		];

		expect(pickWeightedVersion(config, 0)).toBe("candidate");
		expect(pickWeightedVersion(config, 4.99)).toBe("candidate");
		expect(pickWeightedVersion(config, 5)).toBe("baseline"); // boundary is exclusive on the low side
		expect(pickWeightedVersion(config, 99.99)).toBe("baseline");
	});

	it("falls back to the last entry for a roll of exactly 100 (should not happen, but must not crash)", () => {
		const config = [
			{ versionId: "a", traffic: 50 },
			{ versionId: "b", traffic: 50 },
		];
		expect(pickWeightedVersion(config, 100)).toBe("b");
	});

	it("handles three-way splits correctly", () => {
		const config = [
			{ versionId: "a", traffic: 25 },
			{ versionId: "b", traffic: 25 },
			{ versionId: "c", traffic: 50 },
		];
		expect(pickWeightedVersion(config, 10)).toBe("a");
		expect(pickWeightedVersion(config, 30)).toBe("b");
		expect(pickWeightedVersion(config, 60)).toBe("c");
	});
});
