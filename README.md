# The Forward Pass engine

The open-source engine behind [The Forward Pass](https://theforwardpass.net), an AI engineering briefing. It collects public sources, groups related stories, extracts facts from captured evidence, writes and checks editions, and delivers them by email or chat.

The engine runs on Cloudflare Workers with Workflows, R2 and Durable Objects. The collection and editorial code also runs in Node.js for local jobs. The hosted website is a separate application.

## What is included

- RSS, Atom, publication-index and public API collection, with bounded retrieval and optional Browser Rendering.
- Story clustering, attention measurements and editorial selection, including chips, memory and local-inference hardware.
- Fact extraction with source quotes, writing checks and final grounding checks.
- Daily issues, optional personal editions, weekly research and compute reports.
- Email delivery with recipient claims, sent receipts and provider idempotency keys.
- Slack, Discord and Telegram delivery code, plus an experimental Teams adapter.
- Reader feeds, archive access, votes, signals, MCP and agent credit accounting.
- The source registry, local job tools and regression tests.

This release contains a clean source snapshot. Production secrets, reader records, private chat configuration, operational research archives and the private repository history are excluded. Test fixtures are examples, not a record of current product releases.

## Run locally

Use Node.js 22.13 or newer and npm.

```bash
git clone https://github.com/superuserkalo/forwardpass-engine.git
cd forwardpass-engine
npm ci
npm run typecheck
npm test
npm run check:worker
cp .dev.vars.example .dev.vars
npm run dev
```

Wrangler serves the Worker at `http://localhost:8787`. `GET /feed` returns an empty feed until you have collected and published content. Local storage is separate from deployed R2. Tests use fixtures and mocked services; they do not require production credentials or call paid models.

Add your own provider credentials to `.dev.vars` for Worker development. For Node jobs, copy `.env.example` to `.env.local` instead. Both local secret files are ignored by Git. See [self-hosting](docs/self-hosting.md) for bindings, secrets and deployment.

## Run a local job

```bash
cp .env.example .env.local

# Collect public sources into .delivery without models or sending email.
npm run job -- collect --local

# Generate an issue using local snapshots and your model credentials.
npm run job -- issue YYYY-MM-DD --local --fresh --compute
```

Generation calls paid models, including in a dry run. The role defaults live in `src/pipeline/models.ts`; set `TRIAGE_MODEL`, `FACTS_MODEL`, `EDITOR_MODEL`, `WRITER_MODEL`, `CHECK_MODEL` and `SIGNALS_MODEL` to gateway model IDs available to your account. Several roles also support a matching `*_EFFORT` setting.

Without `--local`, Node jobs read your configured R2 bucket. By default they write results to `.scratch`. `--live` writes R2, `--live --publish` publishes an issue, and `deliver YYYY-MM-DD --live` sends it to the configured audience. The template does not contain credentials for the hosted service.

## Change the source registry

Edit `docs/source-catalog.json`, then run:

```bash
npm run sources:registry
```

This regenerates `src/lib/source-catalog.generated.ts`. Registry entries describe collection routes, not guaranteed availability. Permission-required routes remain disabled unless separately supported. Source publishers retain their rights to fetched content.

## Code map

| Path | Purpose |
| --- | --- |
| `src/worker.ts` | HTTP routes, scheduled jobs and durable Workflow classes |
| `src/collect/` | Main and fast collection lanes |
| `src/pipeline/` | Clustering, selection, evidence, writing and verification |
| `src/delivery/` | Shared, personal, weekly and chat delivery |
| `src/api/` | Reader, signals, MCP, billing and chat routes |
| `src/lib/` | Story records, source registry, storage and access helpers |
| `src/node/` | Local and R2-backed Node job adapters |
| `scripts/` | Tests, local jobs, registry generation and previews |

See [architecture](docs/architecture.md) and the [reader API](docs/reader-api.md).

## Deployment defaults

The public Wrangler template uses example resource names and has daily and editorial autopublishing disabled. Personal editions, weekly research, scheduled signals, the fast lane and automatic credit refill are also disabled. The cron schedule still collects sources and runs daily generation after deployment. Remove the entries in `triggers.crons` if you want manual runs only. Model and infrastructure use can incur charges.

Delivery requires your own provider accounts, verified sender and opted-in audience. The billing integration requires your own Polar product and credentials. No live model, delivery or billing service comes with a clone of the repository.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and pull requests, and [SECURITY.md](SECURITY.md) for private vulnerability reports.

The [dependency audit notes](docs/dependencies.md) record the advisories still reported for the initial public snapshot.

The engine code and included documentation use the [MIT license](LICENSE). Third-party dependencies keep their own licenses. The license does not grant rights to third-party articles fetched by the engine or to The Forward Pass name and branding.
