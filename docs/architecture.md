# Architecture

The engine shares its collection, editorial and delivery functions between a Cloudflare Worker and Node job tools.

## Collection and writing

The editable source catalog generates a registry of public feeds, APIs and publication indexes. Collection shards retrieve those routes, resolve article text, record health and measure attention. Workflows checkpoint their completed steps in R2 so a retry can reuse successful work.

The daily pipeline reads recent snapshots, groups URLs into story clusters and shortlists candidates. Batched model triage and editorial selection choose featured stories and shorter signals. Fact extraction records quotes from captured source text. Writing and grounding checks run before the issue can be published. Checks reduce errors; they do not establish that every generated claim is correct.

An issue contains structured story records with stable IDs. The archive, feed, email and agent responses use those records. Older editions can still be read through the legacy Markdown parser. Personal editions and weekly research use separate flags.

## Runtime and storage

`src/worker.ts` exports the HTTP handler, scheduled handler and Workflow classes. The Worker uses an R2 binding through the object-store interface in `src/lib/private-store.ts`. Node jobs use the same interface with local files, S3-compatible R2 access or a read-through dry-run store.

Durable Objects maintain the agent credit ledger, chat destination registry and signals index. The configured dynamic Worker loader executes agent code through the code-mode integration. Browser Rendering is an optional collection fallback.

## Delivery and access

Delivery stages recipients in pages and checks consent before sending. Recipient claims, sent receipts and Resend idempotency keys limit duplicate sends. Uncertain sends beyond the retry window need reconciliation.

Reader access uses signed tokens and current entitlements in Resend. MCP has separate revocable agent keys, rate limits and credit accounting. The Polar integration reconciles paid events. Chat connection and delivery use the operator's provider apps.

The public repository does not include the hosted website, its account UI or its billing checkout. A self-hosted website must implement the reader and connection flows it needs and share the preferences-signing secret with its own Worker.
