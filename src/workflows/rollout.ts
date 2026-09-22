// The self-healing loop. Given a candidate version, walks it through
// increasing traffic shares with a bake window and an SLO gate between each
// step. Durable: if the Worker restarts mid-bake, the Workflow resumes at
// the same phase rather than losing the rollout. If the gate fails at any
// phase, traffic reverts to 100% baseline and the rollout is marked
// rolled_back — no human in the loop required.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { DeployConfigEntry, Env } from "../types";
import { DEFAULT_SLO, PHASE_BAKE_MS, ROLLOUT_PHASES } from "../types";
import { newId } from "../lib/ids";

export interface RolloutParams {
	promptId: string;
	rolloutId: string;
	candidateVersionId: string;
	baselineVersionId: string;
}

export class RolloutWorkflow extends WorkflowEntrypoint<Env, RolloutParams> {
	override async run(event: WorkflowEvent<RolloutParams>, step: WorkflowStep) {
		const { promptId, rolloutId, candidateVersionId, baselineVersionId } = event.payload;
		const stub = this.env.PROMPT.get(this.env.PROMPT.idFromName(promptId));

		for (const [phaseIndex, candidateTraffic] of ROLLOUT_PHASES.entries()) {
			const phaseStart = await step.do(`set-traffic-phase-${phaseIndex}`, async () => {
				const config: DeployConfigEntry[] =
					candidateTraffic === 100
						? [{ versionId: candidateVersionId, traffic: 100 }]
						: [
								{ versionId: candidateVersionId, traffic: candidateTraffic },
								{ versionId: baselineVersionId, traffic: 100 - candidateTraffic },
							];

				const deploymentId = newId("dep");
				const now = Date.now();

				await stub.setRouting({ promptId, config, deploymentId, rolloutId });
				await this.env.DB.prepare(
					`INSERT INTO deployments (id, prompt_id, config, reason, rolled_back_to, rollout_id, created_at)
					 VALUES (?, ?, ?, 'rollout_phase', NULL, ?, ?)`,
				)
					.bind(deploymentId, promptId, JSON.stringify(config), rolloutId, now)
					.run();
				await this.env.DB.prepare(`UPDATE rollouts SET phase = ? WHERE id = ?`)
					.bind(phaseIndex, rolloutId)
					.run();

				return now;
			});

			// Durable sleep: costs nothing while parked, survives restarts.
			await step.sleep(`bake-phase-${phaseIndex}`, PHASE_BAKE_MS);

			const verdict = await step.do(`gate-phase-${phaseIndex}`, async () => {
				return stub.computeSlo(candidateVersionId, phaseStart, DEFAULT_SLO);
			});

			if (!verdict.pass) {
				await step.do("auto-rollback", async () => {
					const config: DeployConfigEntry[] = [{ versionId: baselineVersionId, traffic: 100 }];
					const deploymentId = newId("dep");
					const now = Date.now();

					await stub.setRouting({ promptId, config, deploymentId, rolloutId: null });
					await this.env.DB.prepare(
						`INSERT INTO deployments (id, prompt_id, config, reason, rolled_back_to, rollout_id, created_at)
						 VALUES (?, ?, ?, 'auto_rollback', NULL, ?, ?)`,
					)
						.bind(deploymentId, promptId, JSON.stringify(config), rolloutId, now)
						.run();

					const reason = `SLO breach at ${candidateTraffic}% (${verdict.breaches.join(", ")}), n=${verdict.sampleCount}`;
					await this.env.DB.prepare(
						`UPDATE rollouts SET status = 'rolled_back', outcome_reason = ?, ended_at = ? WHERE id = ?`,
					)
						.bind(reason, now, rolloutId)
						.run();
				});

				return { status: "rolled_back" as const, phase: phaseIndex, breaches: verdict.breaches };
			}
		}

		// All phases passed at 100% for a full bake window — promote.
		await step.do("promote", async () => {
			await this.env.DB.prepare(
				`UPDATE rollouts SET status = 'promoted', outcome_reason = 'all phases passed SLO', ended_at = ? WHERE id = ?`,
			)
				.bind(Date.now(), rolloutId)
				.run();
		});

		return { status: "promoted" as const };
	}
}
