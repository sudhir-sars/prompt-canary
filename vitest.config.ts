import { defineConfig } from "vitest/config";

// Plain node environment, not @cloudflare/vitest-pool-workers: these tests
// cover pure logic (SLO gating, traffic-split math) that intentionally has
// no dependency on the Workers runtime, D1, or Durable Object storage. That
// separation is deliberate — it's what makes the SLO gate's edge cases
// testable in milliseconds instead of needing a live rollout + bake window.
export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
	},
});
