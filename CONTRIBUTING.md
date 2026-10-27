# Contributing

Open an issue with a reproducible example for a bug, or explain the intended behavior for a proposed change. Keep pull requests focused. Include the behavior before and after the change and the checks you ran.

Use Node.js 22.15 or newer. Install the locked dependencies with `npm ci`, then run:

```bash
npm run sources:registry
npm run typecheck
npm test
npm run check:worker
```

Commit registry changes together with the generated TypeScript file. Add regression coverage for changes to access checks, billing, delivery deduplication, source retrieval or editorial verification. Do not use the TypeScript `any` type. Use `unknown` with validation when an input has no established shape.

Use synthetic data for fixtures. Do not include reader details, provider tokens, real connection codes, local environment files or production exports. A test must not send email, register a provider app, publish an edition or call a paid model.

Contributions are submitted under the repository's MIT license. For security reports, follow [SECURITY.md](SECURITY.md).
