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

