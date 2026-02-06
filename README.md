# TransCrab

A local-first pipeline for turning links into a beautiful translated reading site.

**Designed for OpenClaw assistants.**

## What you get

After setup, your assistant can take a link + the keyword `crab` and will:

1) fetch the article
2) convert HTML → Markdown
3) translate Markdown (default: zh-Hans)
4) commit + push
5) Netlify rebuilds → you get a polished page URL

## Quick start (recommended)

For most users, a single repo is enough:

1) **Fork** this repo
2) Deploy your fork to Netlify
   - Build command: `npm run build`
   - Publish directory: `dist`
3) Use your assistant to add articles (URL → `crab`)

## Upgrading / keeping in sync with upstream

In your fork clone, add this repo as `upstream`, then merge updates when needed:

```bash
git remote add upstream https://github.com/onevcat/transcrab.git
git fetch upstream
git merge upstream/main
git push
```

(If you prefer a one-command workflow, see `scripts/sync-upstream.sh`.)

## One-time setup (tell your assistant)

Copy/paste to your OpenClaw assistant:

> Fork `onevcat/transcrab` to my GitHub.
> Deploy the fork to Netlify (build: `npm run build`, publish: `dist`).
> When I send a URL then send `crab`, add the article: fetch → markdown → translate zh → commit + push, and reply with the new page URL.

## Daily use

- Send a URL, then send `crab`.
- If you want a different behavior, explicitly say so (e.g. `raw`, `sum`, `tr:ja`).

## Requirements (local)

- Node.js 22+
- OpenClaw gateway running locally

## License

MIT
