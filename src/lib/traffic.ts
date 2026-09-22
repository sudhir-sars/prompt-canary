// Pure traffic-split math, factored out of PromptDO for the same reason as
// slo.ts: testable without a Durable Object runtime.

import type { DeployConfigEntry } from "../types";

// `roll` is injected (rather than calling Math.random() internally) so
// tests can assert exact boundaries deterministically.
export function pickWeightedVersion(config: DeployConfigEntry[], roll: number): string | null {
	if (config.length === 0) return null;
	if (config.length === 1) return config[0]!.versionId;

	let cumulative = 0;
	for (const entry of config) {
		cumulative += entry.traffic;
		if (roll < cumulative) return entry.versionId;
	}
	return config[config.length - 1]!.versionId;
}
