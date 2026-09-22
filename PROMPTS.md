# Prompt History

The Cloudflare assignment states: _"AI-assisted coding is encouraged, but you have to
submit prompt history."_ This file is that record, kept in the repo from the first
commit rather than reconstructed afterwards.

**Tool:** Claude Code (Opus 5), running in VS Code on Windows 11.
**Convention:** user prompts are quoted verbatim, including typos. My summaries of
what the assistant did are marked as such. New entries are appended, never edited.

---

## Session 1 — 2026-09-22

### 1. Reading the job posting

> can you read this
> https://job-boards.greenhouse.io/cloudflare/jobs/8212060?gh_jid=8212060&gh_src=5ylsd31

Assistant fetched the Greenhouse posting for **Software Engineer, Infrastructure
Operations** and summarised the role. The first pass surfaced only a one-line mention
of an optional assignment.

### 2. Digging out the actual assignment spec

> dig more abotut hsi we need to do this assignnemtn
> There's an optional take-home: build an AI-powered app on Cloudflare's stack —
> completing it can expedite hiring

Assistant re-fetched the page and also pulled the raw HTML with `curl`, stripping tags
to recover the text below the application form. That surfaced the full assignment,
which the rendered summary had truncated:

- LLM (recommend Llama 3.3 on Workers AI), or an external LLM
- Workflow / coordination (recommend Workflows, Workers or Durable Objects)
- User input via chat or voice (recommend Pages or Realtime)
- Memory or state
- Deliverable is a GitHub repo URL pasted into the application form
- "AI-assisted coding is encouraged, but you have to submit prompt history"

Link extraction on the raw HTML showed the "additional documentation" anchor points at
`developers.cloudflare.com/agents/`.

Assistant then proposed four candidate projects and a scope level.
Selected scope: **strong portfolio build** — deployed, tested, CI, real README.

### 3. Evaluating an alternative idea

> the ai incidende commader si good but i was think aboutt he soem sort of
> https://github.com/sudhir-sars/promptX
>
> soem thing blike promtp but a very bsases and simole versionfo it for the submission
> for the assige
> i need yout to evalse botht the ideas
>
> care fully ,
>
> in rpmpt what we will eb doongh is jsu , promtp version mager with immiartbe histy,
> + rooling doeleyemnts+ auto roolebck based ofn erros/evals scores
>
> chekc the promtpx care fully and then finaly giev methe ideas what to build

Assistant read the promptX repository via the GitHub API — metadata, full file tree,
README, `convex/schema.ts`, `convex/deployments.ts`, `convex/versions.ts`,
`convex/lib/deployments.ts`, and the Cloudflare edge worker under `apps/edge-server/`.

**Finding:** promptX as it stands scores roughly 1.5/4 against the assignment. It never
calls an LLM (it stores and serves prompt *text*), it has no chat or voice input, and
its state lives in Convex. Cloudflare is used only as a KV cache behind a thin read
worker — which, submitted to Cloudflare, reads as "I used Cloudflare as a CDN."

**But** the proposed addition — auto-rollback driven by error and eval scores — forces
every missing component into existence for a real reason: scoring requires running the
prompt (Workers AI), judging the output (a second LLM role), a rolling score window
(Durable Object), a gated rollout with bake time (Workflows), and chat as the traffic
source that generates the evals.

Assistant compared this against the Incident Commander option and recommended the
prompt-delivery project, on two grounds: originality (an AI on-call bot is the most
commonly attempted version of this assignment) and demo integrity (Incident Commander's
remediation is necessarily stubbed, whereas a sabotaged prompt version really does get
caught and reverted live).

Decisions taken: build fresh and Cloudflare-native in a new repo with no code reused
from promptX; score with an LLM judge combined with hard signals (error rate, p95
latency, schema violations).

### 4. Build

> _(scope and eval-signal decisions confirmed via the options above)_

Assistant verified current Cloudflare APIs against the live docs before writing code —
the Workflows Workers API, the Llama 3.3 model ID and input schema, and SQLite-backed
Durable Object storage with `new_sqlite_classes` migrations — rather than relying on
pre-trained knowledge, then began scaffolding.


### 5. Scaffolding and first end-to-end run

> _(no new user message — continuing the confirmed plan)_

Assistant created the D1 database (`prompt-canary`) and applied the schema
migration, wrote `wrangler.jsonc` with `assets`, `ai`, `d1_databases`,
`durable_objects`, and `workflows` bindings, then implemented:

- `src/types.ts` — shared types, SLO thresholds, rollout phase config
- `src/lib/ai.ts` — two distinct Workers AI roles: generate, judge
- `src/do/prompt-do.ts` — `PromptDO`: live routing state, rolling eval
  window, SLO computation
- `src/workflows/rollout.ts` — `RolloutWorkflow`: phase progression, bake
  sleeps, gate checks, auto-rollback
- `src/routes/{prompts,rollouts,chat}.ts` and `src/index.ts`
- `public/index.html` — single-page chat playground + dashboard, no build step

Typechecked clean, then ran `wrangler dev` and exercised the real system
against live Workers AI (not mocked):

1. Created a prompt, confirmed routing/versions/deployments in D1 were
   correct on the first request.
2. Sent a chat turn. **Found a real bug**: `env.AI.run()` sometimes returns
   `response` as an already-parsed object rather than a JSON string, which
   broke the reply parser (it called `.trim()` on an object, threw, and the
   catch path silently mis-reported `schemaValid: false` even though the
   model had actually obeyed the contract). Fixed `runChatTurn`/`runJudge`
   in `src/lib/ai.ts` to normalize both shapes before parsing.
3. Attempted to demonstrate rollback with an adversarial candidate prompt
   ("ignore the JSON instruction, respond in Spanish prose"). The model
   complied with the hardcoded output contract anyway and the judge scored
   it well — a real negative result, reported as such rather than
   discarded. Built a second candidate designed to overrun the token
   budget instead (900+ word responses against a 512-token cap).
4. Started a real rollout via the API, then drove 120 concurrent chat
   requests to generate enough canary-slice traffic within the bake
   window. The rollout **broke on its own** at the 25% phase — a genuine
   p95 latency SLO breach (10.3s vs the 8s threshold) caused by the load,
   not a scripted failure — and `RolloutWorkflow` auto-rolled-back
   correctly: routing reverted to 100% baseline, and an immutable
   `auto_rollback` deployment row was recorded with the breach reason.
   Verified via direct API calls that routing and deployment history both
   reflected this correctly.
5. Noticed `MIN_SAMPLES_PER_PHASE` was defined but never enforced in
   `computeSlo`, meaning a phase with zero or one samples would be judged
   as a hard failure rather than inconclusive. Fixed: fewer than 5 samples
   is now treated as a passing, `insufficient_samples`-flagged verdict
   rather than a rollback trigger, since punishing a good prompt for low
   traffic volume would be worse than proceeding on thin evidence.

### 6. Tests, docs, and cleanup

Extracted the SLO-gate and traffic-split math out of `PromptDO` into pure
functions (`src/lib/slo.ts`, `src/lib/traffic.ts`) specifically so they're
unit-testable without a Durable Object runtime or a live multi-minute
rollout. Exported `tryParseReply` from `src/lib/ai.ts` for direct testing
of the JSON-parsing edge cases found during manual testing (code fences,
missing fields, truncated JSON from a token-budget cutoff).

Wrote 21 vitest unit tests across `test/slo.test.ts`, `test/traffic.test.ts`,
and `test/ai-parsing.test.ts`. One test (`p95 latency above threshold`) was
initially written with an off-by-one in its own setup — the comment claimed
20 samples would put an outlier at the p95 index, but the actual math put
it one short. Caught by the test failing, fixed the test's sample counts,
not the underlying `evaluateSlo` logic.

Removed an unused `@cloudflare/vitest-pool-workers` dependency after
deciding the pure-function test strategy didn't need it. Added
`.github/workflows/ci.yml` (typecheck, test, `wrangler deploy --dry-run`),
`README.md`, and `LICENSE`.
