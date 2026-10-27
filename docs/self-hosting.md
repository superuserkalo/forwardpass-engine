# Self-hosting

Use your own Cloudflare account, model gateway and delivery providers. The template contains example names and empty provider credentials.

## Local development

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

Wrangler reads Worker secrets from `.dev.vars` and simulates local storage bindings. Node jobs read `.env.local` through the `job` script. Copy `.env.example` when using those jobs. Neither file belongs in Git. See Cloudflare's [local environment documentation](https://developers.cloudflare.com/workers/local-development/environment-variables/).

An empty `GET /feed` works without provider keys. Collection makes requests to public sources. Generation needs model credentials. Authenticated reader requests, email delivery and chat each need their related provider settings.

## Configure Cloudflare resources

Change the Worker name, R2 bucket name and Workflow resource names in `wrangler.jsonc` to names owned by your deployment. Keep the binding and class names unchanged. The `forwardpass-example` names avoid the hosted engine's resource names. Rate-limit namespace IDs must be unique within your account.

The runtime uses Workers, Workflows, an EU-jurisdiction R2 bucket, Durable Objects, Browser Rendering and a dynamic Worker loader. Access and billing for those services depend on your Cloudflare account. Create the configured bucket in the EU jurisdiction:

```bash
npx wrangler login
npx wrangler r2 bucket create YOUR_BUCKET_NAME --jurisdiction eu
npm run types
npm run typecheck
npm test
npm run check:worker
```

`src/node/store.ts` uses the EU R2 endpoint. If you choose another jurisdiction, update that adapter and the binding together. The Worker itself uses its R2 binding.

Inspect the [Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/) when changing bindings. The dry-run command validates and bundles the Worker without deploying it.

## Add credentials

Store deployed credentials with `npx wrangler secret put NAME`. Use the interactive prompt so a secret does not become part of shell history.

| Capability | Settings |
| --- | --- |
| Model generation | `AI_GATEWAY_API_KEY`; optional role-specific model and effort overrides |
| Admin API | `ADMIN_TOKEN`, at least 32 characters |
| Signed reader access | `PREFERENCES_SIGNING_SECRET`, at least 32 characters; the website must use the same secret |
| Email delivery | `RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `NEWSLETTER_FROM`; optional `NEWSLETTER_REPLY_TO` |
| Owner alerts | `ALERT_EMAIL` plus the email settings |
| Optional collection auth | `GITHUB_TOKEN`, `HF_TOKEN` |
| Slack | `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_ENCRYPTION_KEY` |
| Discord | `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET_TOKEN` |
| Experimental Teams | `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_APP_TENANT_ID`, `TEAMS_APP_TYPE` |
| Optional Polar credit payments | `POLAR_ACCESS_TOKEN`, your `POLAR_PRODUCT_AGENT_CREDITS` ID and explicit `POLAR_OFF_SESSION_ENABLED` |
| Node access to your R2 data | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in `.env.local` |

The Node R2 credentials are unnecessary for the Worker binding. Set `PUBLIC_SITE_URL` in `wrangler.jsonc` to your own website before generating public links. Optional `INDEXNOW_KEY` must belong to that website.

`scripts/chat-setup.mjs` can generate provider registration assets. Supply your own `CHAT_BACKEND_URL`, review the generated names, domains and app IDs, then configure your provider apps. Registration commands change those apps and should only be run for apps you own. The Teams registration template needs your own website and policy URLs before use.

## Deploy and schedule

```bash
npm run deploy
```

The checked-in schedule is UTC. It collects every two hours, generates a daily issue at 05:30, checks optional weekly jobs on Sunday and runs health checks twice a day. The fast lane is disabled. Daily and editorial autopublishing, personal editions, weekly jobs, scheduled signals and automatic credit refill are disabled by default.

The daily generation schedule can call paid models even while autopublishing is disabled. For manual operation, set `triggers.crons` to `[]` before deploying. Keep the example expressions in a local note if you want to restore them later. The schedule regression tests describe the checked-in template, so update them with an intentional schedule change.

Configure storage and the gateway, inspect a generated issue, then test delivery with an audience you control before enabling autopublishing. Deployment success confirms that the Worker was uploaded. Check Workflow status, published markers and delivery receipts to verify a run.

## Limits of this release

This is the production engine source with a public deployment template. It includes integrations specific to The Forward Pass, rather than a general newsletter setup wizard. Running your own publication requires adapting its website links, provider registration and sender identity. Model IDs and provider capabilities can change; set supported IDs for your account before running generation.
