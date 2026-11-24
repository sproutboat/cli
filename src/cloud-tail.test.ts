import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainTailRefusal, shortSecretWarnings } from "./cloud-logs";

const KEY = "sbk_tailtest0123456789";
const T0 = new Date(2026, 0, 2, 3, 4, 5, 6).getTime();
const sse = (frames: object[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
const reqEvent = (url: string, status: number) => ({
  type: "event",
  event: {
    scriptName: "blog",
    outcome: "ok",
    eventTimestamp: T0,
    event: { request: { url, method: "GET" }, response: { status } },
    cpuTime: null,
    wallTime: 12.3,
    logs: [],
    exceptions: [],
  },
});
const lineEvent = (text: string) => ({
  type: "event",
  event: {
    scriptName: "blog",
    outcome: "ok",
    eventTimestamp: T0,
    event: null,
    cpuTime: null,
    wallTime: 0,
    logs: [{ level: "log", message: [text], timestamp: T0 }],
    exceptions: [],
  },
});

type Seen = { path: string; query: URLSearchParams; auth: string | null };
const seen: Seen[] = [];
let attempts = 0;
let mode: "ok" | "forbidden" | "viewers" | "missing" | "times" | "stamped" = "ok";
let server: ReturnType<typeof Bun.serve>;
let dir: string;
let projectDir: string;

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/config") return Response.json({ ingress: "public", github: false, public_url: null });
      if (url.pathname === "/v1/whoami")
        return Response.json({
          kind: "key",
          key: { permissions: {} },
          organization: { slug: "acme", name: "Acme" },
          organization_slug: "acme",
        });
      seen.push({ path: url.pathname, query: url.searchParams, auth: req.headers.get("authorization") });
      if (mode === "forbidden")
        return Response.json({ error: "logs:read", reason: "forbidden", need: "logs:read" }, { status: 403 });
      if (mode === "missing") return Response.json({ error: "no such app" }, { status: 404 });
      if (mode === "viewers")
        return Response.json(
          { error: "too many live tails", reason: "tail-viewers", scope: "app", retry_after: 30 },
          { status: 429, headers: { "retry-after": "30" } },
        );
      if (url.pathname === "/v1/apps/blog/logs") {
        const lines = ["one", "sproutd: request GET /a 200 ok 1.0ms", "two"];
        const retention = "7 days";
        if (mode === "times")
          return Response.json({ project: "blog", lines, times: [null, 1795532400123, 1795532461000], retention });
        if (mode === "stamped")
          return Response.json({
            project: "blog",
            lines: ["@1795532400123 one", "an older line", "@1795532461000 two"],
            retention,
          });
        return Response.json({ project: "blog", lines, retention });
      }
      if (url.pathname === "/v1/apps/blog/tail") {
        attempts++;
        // The first session ends at the server's time cap; the CLI opens the next one.
        return new Response(
          attempts === 1
            ? sse([
                { type: "ready" },
                reqEvent("http://blog.acme.sproutboat.app/a", 200),
                { type: "dropped", count: 4, reason: "rate" },
                { type: "closed", reason: "time" },
              ])
            : sse([{ type: "ready" }, lineEvent("hello from the app")]),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("nope", { status: 404 });
    },
  });
  dir = await mkdtemp(join(tmpdir(), "sb-cloud-tail-"));
  projectDir = join(dir, "blog");
  await mkdir(join(projectDir, "src"), { recursive: true });
  await writeFile(
    join(projectDir, "sproutboat.jsonc"),
    JSON.stringify({ name: "blog", main: "src/index.js", compatibility_date: "2026-11-18" }),
  );
});
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

async function run(args: string[], opts: { kill?: boolean } = {}) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "tail", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      SPROUTBOAT_ACCOUNT: "acme",
      SPROUTBOAT_API_URL: `http://127.0.0.1:${server.port}`,
      SPROUTBOAT_API_TOKEN: KEY,
      SPROUTBOAT_NO_UPDATE_CHECK: "1",
      TZ: "UTC",
      XDG_CONFIG_HOME: join(dir, "cfg"),
      HOME: dir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.kill) {
    // wait for both sessions' output, then Ctrl-C
    const timer = setTimeout(() => child.kill("SIGINT"), 2500);
    await child.exited;
    clearTimeout(timer);
  } else await child.exited;
  return {
    code: child.exitCode,
    out: await new Response(child.stdout).text(),
    err: await new Response(child.stderr).text(),
  };
}

test("tail on a Cloud: the Cloud route with the key and the filters, Wrangler-shaped output, reconnect after the session cap, exit 0 on Ctrl-C", async () => {
  seen.length = 0;
  attempts = 0;
  mode = "ok";
  const r = await run([projectDir, "--status", "5xx", "--method", "get", "--search", "needle", "--format", "json"], {
    kill: true,
  });
  expect(r.code).toBe(0);
  expect(seen[0]!.path).toBe("/v1/apps/blog/tail");
  expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
  expect(seen[0]!.query.getAll("status")).toEqual(["5xx"]);
  expect(seen[0]!.query.getAll("method")).toEqual(["GET"]);
  expect(seen[0]!.query.get("search")).toBe("needle");
  expect(attempts).toBeGreaterThanOrEqual(2);
  const events = r.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(events[0].event.request).toEqual({ url: "http://blog.acme.sproutboat.app/a", method: "GET" });
  expect(events.at(-1).logs[0].message).toEqual(["hello from the app"]);
  expect(r.err).toContain("4 events dropped (event rate limit)");
}, 20_000);

test("tail on a Cloud, pretty: a request line and a flush-left console line", async () => {
  attempts = 0;
  mode = "ok";
  const r = await run(["--name", "blog"], { kill: true });
  expect(r.code).toBe(0);
  expect(r.out).toContain("GET");
  expect(r.out).toContain("http://blog.acme.sproutboat.app/a");
  expect(r.out).toContain("hello from the app");
  expect(r.err).toContain("tailing live");
}, 20_000);

test("tail --recent prints the host's lines oldest first; --lines is sent; --sprout is the same; --format json prints the answer", async () => {
  seen.length = 0;
  mode = "ok";
  const r = await run([projectDir, "--recent", "--lines", "25"]);
  expect(r.code).toBe(0);
  expect(r.out).toBe("one\nsproutd: request GET /a 200 ok 1.0ms\ntwo\n");
  expect(seen[0]!.path).toBe("/v1/apps/blog/logs");
  expect(seen[0]!.query.get("lines")).toBe("25");
  const sprout = await run(["--name", "blog", "--sprout"]);
  expect(sprout.out).toBe(r.out);
  expect(seen[1]!.query.get("lines")).toBe("100");
  const json = JSON.parse((await run(["--name", "blog", "--recent", "--format", "json"])).out);
  expect(json).toEqual({
    project: "blog",
    lines: ["one", "sproutd: request GET /a 200 ok 1.0ms", "two"],
    retention: "7 days",
  });
});

test("tail --recent shows the time of each line where the Cloud sends it, and an unstamped line still prints", async () => {
  mode = "times";
  const r = await run(["--name", "blog", "--recent"]);
  expect(r.code).toBe(0);
  expect(r.out).toBe(
    "                        one\n2026-11-24 15:00:00.123 sproutd: request GET /a 200 ok 1.0ms\n2026-11-24 15:01:01.000 two\n",
  );
  const json = JSON.parse((await run(["--name", "blog", "--recent", "--format", "json"])).out);
  expect(json.times).toEqual([null, 1795532400123, 1795532461000]);
  // lines that carry the host's stamp in their text are read the same way
  mode = "stamped";
  const inline = await run(["--name", "blog", "--recent"]);
  expect(inline.out).toBe(
    "2026-11-24 15:00:00.123 one\n                        an older line\n2026-11-24 15:01:01.000 two\n",
  );
  mode = "ok";
});

test("refusals are clear and final: 403 names logs:read, 404 says to deploy, 429 says how many viewers; --recent says the same", async () => {
  for (const [m, words] of [
    ["forbidden", "logs:read"],
    ["missing", "is not deployed"],
    ["viewers", "too many people are tailing this app"],
  ] as const) {
    mode = m;
    attempts = 0;
    const live = await run(["--name", "blog"]);
    expect(live.code, m).toBe(1);
    expect(live.err, m).toContain(words);
    expect(live.err, m).not.toMatch(/TailError|\n\s+at /);
    expect(attempts, m).toBe(0);
    if (m !== "viewers") {
      const recent = await run(["--name", "blog", "--recent"]);
      expect(recent.code, m).toBe(1);
      expect(recent.err, m).toContain(words);
    }
  }
  mode = "ok";
  const tooMany = await run(["--name", "blog", "--recent", "--lines", "1001"]);
  expect(tooMany.code).not.toBe(0);
  expect(tooMany.err).toContain("at most 1000 lines");
});

test("explainTailRefusal: what is final and what is left to the reconnect loop", () => {
  expect(explainTailRefusal("blog", 401, undefined)).toContain("sproutboat login");
  expect(explainTailRefusal("blog", 403, undefined)).toContain("logs:read");
  expect(explainTailRefusal("blog", 404, undefined)).toContain("blog is not deployed");
  expect(explainTailRefusal("blog", 429, { reason: "tail-viewers", scope: "team", retry_after: 30 })).toContain(
    "this team",
  );
  expect(explainTailRefusal("blog", 503, { reason: "app-not-ready" })).toContain("not running it yet");
  expect(explainTailRefusal("blog", 503, { reason: "host-unavailable" })).toBeUndefined();
  expect(explainTailRefusal("blog", 502, undefined)).toBeUndefined();
});

test("a secret shorter than 8 characters gets a warning that names it and never shows a value", () => {
  expect(shortSecretWarnings({ LONG: "12345678", PIN: "1234", OTHER: "abc" })).toEqual([
    expect.stringContaining("PIN, OTHER are shorter than 8 characters"),
  ]);
  expect(shortSecretWarnings({ ONE: "x" })[0]).toContain("ONE is shorter");
  expect(JSON.stringify(shortSecretWarnings({ PIN: "1234" }))).not.toContain("1234");
  expect(shortSecretWarnings({ LONG: "12345678" })).toEqual([]);
});
