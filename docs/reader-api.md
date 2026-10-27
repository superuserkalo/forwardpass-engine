# Reader API: feed, editorial and votes

The website's archive calls these routes (`src/api/reader.ts`). Every
route accepts the signed preferences token as `Authorization: Bearer <token>`.
Without it the caller is an anonymous Free reader.

| Route | Returns |
| --- | --- |
| `GET /feed?limit=48` | Stories from published daily editions in the reader's archive window, newest edition first |
| `GET /editorial` | Published long-form pieces, newest first |
| `GET /editorial/:slug` | One piece with its markdown body |
| `POST /votes` | `{ id, voted }` in, `{ id, upvotes, viewer_has_upvoted }` out |
| `GET /images/:kind/:id` | A generated cover (`daily/<date>` or `editorial/<slug>`), public and immutable |

## Feed

`src/lib/edition-stories.ts` splits the shared daily markdown into numbered
stories (`daily:<date>:<n>`) and quick signals (`daily:<date>:signal:<n>`). One
request reads at most 14 editions. Topics are left empty. The website assigns
them from its own taxonomy.

## Votes

Each vote is one private object, `votes/<story>/<sha256(email)>.json`. Voting
writes it and un-voting deletes it, so retries never change the total. Counts
come from one listing of `votes/`. Anonymous requests get `401`, unknown or
unpublished stories `404`, and more than 60 writes a minute from one reader
`429` (per instance, best effort). Edition-level ids (`daily:<date>`,
`weekly:<date>`) and `editorial:<slug>` are accepted too.

## Editorial pieces

Pieces live privately under `articles/<slug>.json`. Publish one from a markdown
file with front matter:

```markdown
---
title: How to Run Qwen 3.8 27B as a Local Coding Agent
dek: Pick a file, an engine and a harness for your machine.
author: ADHAM KHALED
kind: tutorial
topics: LLMs, Development
image: https://cdn.example.com/qwen.png
published_at: 2026-09-21T09:00:00Z
---

The body in markdown.
```

```bash
npm run articles -- publish path/to/piece.md   # slug defaults to the file name
npm run articles -- list
npm run articles -- remove <slug>
```

`kind` is `deep-dive`, `tutorial` or `opinion`. A piece dated in the future stays
hidden until then. Publishing the same slug again replaces it.

## Covers

After a daily issue publishes, the issue workflow draws one cover from its lead
featured story (`src/lib/cover-images.ts`, `meta/muse-image-1.0` at $0.01 an image,
override with `IMAGE_MODEL`) and pings IndexNow with the new pages. Publishing an
article without `image` draws one too. Both are extras: a failure is logged and
never blocks publishing or delivery.

Covers are stored as base64 JSON under `images/<kind>/<id>.json`. The feed sets
`image` to `/media/daily/<date>` on the lead story only, editorial pieces fall
back to `/media/editorial/<slug>`, and `GET /archive/daily/:date` sends
`X-Cover-Image` when the issue has one. The website serves `/media/...` from
`GET /images/...` and caches it at the edge.

To draw missing covers for already published issues (the last 14 by default):

```bash
curl -X POST "$ENGINE/admin/covers" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" -d '{"articles": true}'
```
