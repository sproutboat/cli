import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devAssetResponse } from "./dev-assets";

let root: string;
const get = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  devAssetResponse(new Request(`http://localhost:8787${path}`, { method, headers }), join(root, "assets"));

function write(notFound: string, runSproutFirst: boolean | string[] = false) {
  const files = {
    "/index.html": "text/html; charset=utf-8",
    "/ui.js": "text/javascript; charset=utf-8",
    "/404.html": "text/html; charset=utf-8",
  };
  writeFileSync(
    join(root, "assets.json"),
    JSON.stringify({
      notFound,
      runSproutFirst,
      files: Object.fromEntries(Object.entries(files).map(([k, type]) => [k, { hash: "h", size: 1, type }])),
      redirects: [{ from: "/old", to: "/ui.js", status: 301 }],
      headers: [{ pattern: "/ui.js", set: [["x-test", "1"]], unset: [] }],
    }),
  );
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sb-dev-assets-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "assets", "ui.js"), "console.log(1)");
  writeFileSync(join(root, "assets", "404.html"), "<h1>gone</h1>");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a file is served before the Worker, with its type and _headers (the better-auth example never calls env.ASSETS)", async () => {
  write("none");
  for (const path of ["/", "/index.html", "/ui.js"]) expect(get(path)?.status).toBe(200);
  expect(await get("/")!.text()).toBe("<h1>home</h1>");
  expect(get("/ui.js")!.headers.get("content-type")).toContain("javascript");
  expect(get("/ui.js")!.headers.get("x-test")).toBe("1");
  expect(get("/ui.js", {}, "HEAD")!.body).toBeNull();
});

test("a miss, a POST and a run_sprout_first path go to the Worker", () => {
  write("none", ["/api/**"]);
  expect(get("/api/me")).toBeNull();
  expect(get("/nope")).toBeNull();
  expect(get("/ui.js", {}, "POST")).toBeNull();
  write("none", true);
  expect(get("/ui.js")).toBeNull();
});

test("redirects apply; not_found_handling answers navigations only", async () => {
  write("single-page-application");
  const redirect = get("/old")!;
  expect([redirect.status, redirect.headers.get("location")]).toEqual([301, "/ui.js"]);
  expect(await get("/dashboard", { "sec-fetch-mode": "navigate" })!.text()).toBe("<h1>home</h1>");
  expect(get("/dashboard/data.json", { accept: "application/json" })).toBeNull();
  write("404-page");
  const page = get("/missing", { accept: "text/html" })!;
  expect([page.status, await page.text()]).toEqual([404, "<h1>gone</h1>"]);
});
