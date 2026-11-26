/**
 * `sproutboat dev` serves static assets the way the deployed edge does: a file that matches is answered from the asset directory before the Worker
 * runs (unless `run_sprout_first` names the path), so a Worker that never calls `env.ASSETS` still gets its `public/` folder. A miss goes to the Worker;
 * `not_found_handling` applies only to page navigations, as on Cloudflare.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { findRedirect, isSproutFirst, matchHeaders, resolveAssetKey, type AssetManifest } from "./assets";

function readManifest(assetsDir: string): AssetManifest | null {
  const path = join(dirname(assetsDir), "assets.json");
  if (!existsSync(path)) return null;
  // SAFETY: written by `buildArtifact` beside the assets directory from the AssetManifest contract.
  return JSON.parse(readFileSync(path, "utf8")) as AssetManifest;
}

const isNavigation = (request: Request): boolean => {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode !== null) return mode === "navigate";
  return (request.headers.get("accept") ?? "").includes("text/html");
};

/** The response the edge would give for `request` from the files alone, or null when the Worker should answer. */
export function devAssetResponse(request: Request, assetsDir: string): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const manifest = readManifest(assetsDir);
  if (manifest === null) return null;
  const { pathname } = new URL(request.url);
  if (isSproutFirst(manifest.runSproutFirst, pathname)) return null;
  const redirect = manifest.redirects ? findRedirect(manifest.redirects, pathname) : null;
  if (redirect) return new Response(null, { status: redirect.rule.status, headers: { location: redirect.location } });
  const file = (key: string): { type: string; body: Buffer } | null => {
    const entry = manifest.files[key];
    const abs = normalize(join(assetsDir, key));
    if (!entry || !abs.startsWith(resolve(assetsDir)) || !existsSync(abs)) return null;
    return { type: entry.type, body: readFileSync(abs) };
  };
  const key = resolveAssetKey(pathname, (k) => manifest.files[k] !== undefined);
  let hit = key ? file(key) : null;
  let status = 200;
  if (hit === null && manifest.notFound === "single-page-application" && isNavigation(request))
    hit = file("/index.html");
  if (hit === null && manifest.notFound === "404-page" && isNavigation(request)) {
    hit = file("/404.html");
    status = 404;
  }
  if (hit === null) return null;
  const headers = new Headers({ "content-type": hit.type });
  for (const rule of manifest.headers ? matchHeaders(manifest.headers, pathname) : []) {
    for (const [name, value] of rule.set) headers.append(name, value);
    for (const name of rule.unset) headers.delete(name);
  }
  return new Response(request.method === "HEAD" ? null : new Uint8Array(hit.body), { status, headers });
}
