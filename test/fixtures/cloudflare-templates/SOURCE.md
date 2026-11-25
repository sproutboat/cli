# Cloudflare's own project files

Every `wrangler.json`, `wrangler.jsonc` and `wrangler.toml` of https://github.com/cloudflare/templates at commit
`9674298` (2026-11), copied unchanged. They are MIT licensed (see LICENSE). `src/cloudflare-templates.test.ts` loads each one
through the Wrangler front end, so a file that Cloudflare ships must load here, and a Wrangler release that adds a field shows
up as a changed warning list.
