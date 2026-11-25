/**
 * The CLI with Wrangler's files as the project: no network. `deploy --prepare-out` writes what a Cloud deploy would upload,
 * so the generated source and the spec of a `wrangler.jsonc` can be compared with the legacy file's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKERS_COMPAT_FLOOR } from "./wrangler-config";

const MAIN = join(import.meta.dir, "main.ts");

async function run(args: string[], env: Record<string, string> = {}, cwd?: string) {
  const p = Bun.spawn(["bun", MAIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    env: { ...process.env, SPROUTBOAT_API_URL: "http://127.0.0.1:9", SPROUTBOAT_API_TOKEN: "", ...env },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}

const HANDLER = `export class Counter { constructor(s, e) {} async fetch() { return new Response("1"); } }
export default {
  async fetch(request, env) { return new Response(env.GREETING); },
  async queue(batch, env) {},
  async scheduled(c, env) {},
};
`;

let root: string;
const project = (name: string, files: Record<string, string>) => {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.js"), HANDLER);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
};
const prepare = async (dir: string, extra: string[] = [], env: Record<string, string> = {}) => {
  const out = join(dir, "out");
  rmSync(out, { recursive: true, force: true });
  const r = await run(["deploy", dir, "--prepare-out", out, ...extra], env, dir);
  return {
    ...r,
    spec: r.code === 0 ? JSON.parse(readFileSync(join(out, "spec.json"), "utf8")) : undefined,
    source: r.code === 0 ? readFileSync(join(out, "sprout.generated.js"), "utf8") : "",
  };
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "wrangler-native-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const COMMON = '"name": "demo", "main": "src/index.js", "compatibility_date": "2026-11-23"';

describe("wrangler.jsonc as the project", () => {
  test("the same app as a legacy file and as a Wrangler file builds the same source and the same spec", async () => {
    const legacy = project("legacy", {
      "sproutboat.jsonc": `{ ${COMMON}, "vars": { "GREETING": "hi" }, "kv_namespaces": ["KV"], "d1_databases": ["DB"],
        "durable_objects": { "COUNTER": "Counter" }, "queues": [{ "binding": "JOBS", "queue": "jobs" }], "triggers": { "crons": ["0 * * * *"] } }`,
    });
    const native = project("native", {
      "wrangler.jsonc": `{ ${COMMON}, "observability": { "enabled": true }, "vars": { "GREETING": "hi" },
        "kv_namespaces": [{ "binding": "KV" }], "d1_databases": [{ "binding": "DB" }],
        "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
        "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }],
        "queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" }], "consumers": [{ "queue": "jobs" }] },
        "triggers": { "crons": ["0 * * * *"] } }`,
    });
    const a = await prepare(legacy);
    const b = await prepare(native);
    expect(a.code, a.err).toBe(0);
    expect(b.code, b.err).toBe(0);
    expect(b.source).toBe(a.source);
    expect(b.spec).toEqual(a.spec);
    expect(a.err).toContain("sproutboat.jsonc is deprecated");
    expect(b.err).not.toContain("deprecated");
  });

  test("toml and json are read too", async () => {
    const toml = project("toml", {
      "wrangler.toml": `name = "demo"\nmain = "src/index.js"\ncompatibility_date = "2026-11-23"\n[vars]\nGREETING = "hi"\n[[kv_namespaces]]\nbinding = "KV"\n`,
    });
    const r = await prepare(toml);
    expect(r.code, r.err).toBe(0);
    expect(r.spec.bindings.map((b: { name: string }) => b.name)).toEqual(["KV"]);
    const json = project("json", { "wrangler.json": `{ ${COMMON}, "vars": { "GREETING": "hi" } }` });
    expect((await prepare(json)).code).toBe(0);
  });

  test("a queue that is only produced is not consumed", async () => {
    const dir = project("queues", {
      "wrangler.jsonc": `{ ${COMMON}, "vars": { "GREETING": "hi" }, "queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" }, { "binding": "AUDIT", "queue": "audit" }], "consumers": [{ "queue": "jobs", "max_batch_size": 3 }] } }`,
    });
    const r = await prepare(dir);
    expect(r.code, r.err).toBe(0);
    expect(r.spec.queue_consumers).toEqual([expect.objectContaining({ queue: "jobs", max_batch_size: 3 })]);
    expect(
      r.spec.bindings.filter((b: { kind: string }) => b.kind === "queue").map((b: { name: string }) => b.name),
    ).toEqual(["JOBS", "AUDIT"]);
  });

  test("--env and CLOUDFLARE_ENV select env.<name>; the flag wins; an unknown env is Wrangler's error", async () => {
    const dir = project("envs", {
      "wrangler.jsonc": `{ ${COMMON}, "vars": { "GREETING": "prod" }, "env": { "staging": { "vars": { "GREETING": "staging" } }, "qa": { "vars": { "GREETING": "qa" } } } }`,
    });
    const flag = await prepare(dir, ["--env", "staging"]);
    expect(flag.code, flag.err).toBe(0);
    expect(flag.source).toContain("staging");
    expect(JSON.parse(readFileSync(join(dir, "out", "build.json"), "utf8")).name).toBe("demo-staging");
    const viaVariable = await prepare(dir, [], { CLOUDFLARE_ENV: "qa" });
    expect(JSON.parse(readFileSync(join(dir, "out", "build.json"), "utf8")).name).toBe("demo-qa");
    expect(viaVariable.source).toContain("qa");
    await prepare(dir, ["--env", "staging"], { CLOUDFLARE_ENV: "qa" });
    expect(JSON.parse(readFileSync(join(dir, "out", "build.json"), "utf8")).name).toBe("demo-staging");
    const unknown = await prepare(dir, ["--env", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('No environment found in configuration with name "nope"');
  });

  test("a legacy file has no environments: --env is refused for it with the way out", async () => {
    const dir = project("legacy-env", { "sproutboat.jsonc": `{ ${COMMON}, "vars": { "GREETING": "x" } }` });
    const r = await run(["check", "--env", "staging"], {}, dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Rename it to wrangler.jsonc");
  });

  test("main outside src/, any var name and typed vars", async () => {
    const dir = project("outside", {
      "wrangler.jsonc": `{ "name": "demo", "main": "./worker.js", "compatibility_date": "2026-11-23", "vars": { "limit": 5, "flag": true } }`,
    });
    writeFileSync(join(dir, "worker.js"), "export default { fetch() { return new Response('ok'); } };\n");
    const r = await prepare(dir);
    expect(r.code, r.err).toBe(0);
    expect(r.source).toContain('"limit":5');
  });
});

describe("the date is Cloudflare's for a Wrangler file", () => {
  const OLD =
    '"name": "demo", "main": "src/index.js", "compatibility_date": "2025-10-08", "vars": { "GREETING": "hi" }';
  test("an old date builds as the floor, prints no warning, and says so in check; the legacy file keeps its own date", async () => {
    const native = project("old-native", { "wrangler.jsonc": `{ ${OLD} }` });
    const legacy = project("old-legacy", { "sproutboat.jsonc": `{ ${OLD} }` });
    const a = await prepare(native);
    const b = await prepare(legacy);
    expect(a.code, a.err).toBe(0);
    expect(b.code, b.err).toBe(0);
    expect(a.spec.compatibility_date).toBe(WORKERS_COMPAT_FLOOR);
    expect(b.spec.compatibility_date).toBe("2025-10-08");
    expect(a.source).toContain(WORKERS_COMPAT_FLOOR);
    expect(a.source).not.toContain("2025-10-08");
    expect(b.source).toContain("2025-10-08");
    expect(a.err).not.toContain("compatibility_date");
    const check = await run(["check"], {}, native);
    expect(check.out).toContain(`compat    2025-10-08 is Cloudflare's date: the build uses ${WORKERS_COMPAT_FLOOR}`);
  });

  test("a missing date uses the floor with one warning; a 51-character name is an app, a 52-character one is refused", async () => {
    const dir = project("no-date", {
      "wrangler.jsonc": `{ "name": "${"a".repeat(51)}", "main": "src/index.js", "vars": { "GREETING": "hi" } }`,
    });
    const r = await prepare(dir);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain(`not set: using ${WORKERS_COMPAT_FLOOR}`);
    expect(JSON.parse(readFileSync(join(dir, "out", "build.json"), "utf8")).name).toBe("a".repeat(51));
    const long = project("too-long", {
      "wrangler.jsonc": `{ "name": "${"a".repeat(52)}", "main": "src/index.js", "compatibility_date": "2026-11-23" }`,
    });
    const refused = await run(["check"], {}, long);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("3 to 51 characters");
  });
});

describe("settings, limits and precedence", () => {
  test("sproutboat.settings.jsonc gives the limits to the spec; SPROUTBOAT_LIMITS_* override; the report names the source", async () => {
    const dir = project("limits", {
      "wrangler.jsonc": `{ ${COMMON}, "vars": { "GREETING": "x" }, "limits": { "cpu_ms": 250 } }`,
      "sproutboat.settings.jsonc": `{ "account": "acme", "limits": { "memory_mb": 64, "wall_ms": 20000 } }`,
    });
    const r = await prepare(dir, [], { SPROUTBOAT_LIMITS_MEMORY_MB: "96" });
    expect(r.code, r.err).toBe(0);
    expect(r.spec.limits).toEqual({ memory_mb: 96, wall_ms: 20000, cpu_ms: 250 });
    const none = await prepare(project("nolimits", { "wrangler.jsonc": `{ ${COMMON}, "vars": { "GREETING": "x" } }` }));
    expect(none.spec.limits).toBeUndefined();
  });

  test("a settings file with an unknown key stops the command and names the key", async () => {
    const dir = project("bad-settings", {
      "wrangler.jsonc": `{ ${COMMON}, "vars": { "GREETING": "x" } }`,
      "sproutboat.settings.jsonc": `{ "colour": "green" }`,
    });
    const r = await run(["check"], {}, dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown key "colour"');
  });

  test("both files in one directory: the Wrangler file wins and a deploy refuses while the legacy file carries the team", async () => {
    const dir = project("both", {
      "wrangler.jsonc": `{ ${COMMON}, "vars": { "GREETING": "x" } }`,
      "sproutboat.jsonc": `{ ${COMMON}, "account": "acme", "vars": { "GREETING": "x" } }`,
    });
    const check = await run(["check"], {}, dir);
    expect(check.code, check.err).toBe(0);
    expect(check.err).toContain("using wrangler.jsonc; sproutboat.jsonc is legacy and ignored");
    const deploy = await run(["deploy", "--dry-run"], {}, dir);
    expect(deploy.code).toBe(1);
    expect(deploy.err).toContain("still carries account");
    expect(deploy.err).toContain("sproutboat.settings.jsonc");
    const forced = await run(["check", "-c", "sproutboat.jsonc"], {}, dir);
    expect(forced.code, forced.err).toBe(0);
  });

  test("no project file: the message names all four and the parent search", async () => {
    const dir = join(root, "empty-project");
    mkdirSync(dir, { recursive: true });
    const r = await run(["check", dir], {}, dir);
    expect(r.code).toBe(1);
    expect(r.err).toContain("looked for wrangler.json, wrangler.jsonc, wrangler.toml and sproutboat.jsonc");
  });

  test("an unsupported product warns and the check still passes (Wrangler-parity wording)", async () => {
    const dir = project("warns", {
      "wrangler.jsonc": `{ ${COMMON}, "vars": { "GREETING": "x" }, "ai": { "binding": "AI" }, "observability": { "enabled": true } }`,
    });
    const r = await run(["check"], {}, dir);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("! wrangler.jsonc: ai: Workers AI is not supported; env.AI will be undefined");
    expect(r.err).not.toContain("observability");
  });
});

describe("the same file works with Wrangler itself", () => {
  const wrangler = join(import.meta.dir, "..", "node_modules", ".bin", "wrangler");
  test("wrangler deploy --dry-run accepts the Wrangler file these tests give Sproutboat, with no warning", async () => {
    if (!(await Bun.file(wrangler).exists())) return;
    const dir = project("with-wrangler", {
      "wrangler.jsonc": `{ ${COMMON}, "observability": { "enabled": true }, "vars": { "GREETING": "hi", "N": 1 },
        "kv_namespaces": [{ "binding": "KV" }], "d1_databases": [{ "binding": "DB" }],
        "durable_objects": { "bindings": [{ "name": "COUNTER", "class_name": "Counter" }] },
        "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }],
        "queues": { "producers": [{ "binding": "JOBS", "queue": "jobs" }], "consumers": [{ "queue": "jobs" }] },
        "triggers": { "crons": ["0 * * * *"] },
        "env": { "staging": { "vars": { "GREETING": "s" } } } }`,
    });
    const p = Bun.spawn([wrangler, "deploy", "--dry-run", "--env=", "--outdir", join(dir, "wrangler-out")], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
        NO_COLOR: "1",
        WRANGLER_LOG_PATH: join(dir, "wrangler-logs"),
      },
    });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    expect(code, out + err).toBe(0);
    expect(out + err).not.toContain("WARNING");
    // and Sproutboat reads the very same file
    expect((await run(["check"], {}, dir)).code).toBe(0);
  }, 60_000);
});
