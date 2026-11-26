import { describe, expect, test } from "bun:test";
import { APP_NAME_MAX, parseWranglerConfig, WORKERS_COMPAT_FLOOR } from "./wrangler-config";

const load = (text: string, kind: "wrangler-jsonc" | "wrangler-toml" = "wrangler-jsonc", env?: string) =>
  parseWranglerConfig(text, kind, { file: kind === "wrangler-toml" ? "wrangler.toml" : "wrangler.jsonc", env });
const ok = (text: string, env?: string) => {
  const result = load(text, "wrangler-jsonc", env);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result;
};
const errors = (text: string, env?: string) => {
  const result = load(text, "wrangler-jsonc", env);
  if (result.ok) throw new Error("expected errors");
  return result.errors.join("\n");
};
const base = '"name": "app", "main": "./src/index.ts", "compatibility_date": "2026-11-23"';

describe("the basics", () => {
  test("a stock file loads: comments, trailing commas, ./ in main, silent Cloudflare-only fields", () => {
    const r = ok(`{
      // a comment
      "$schema": "node_modules/wrangler/config-schema.json",
      ${base},
      "account_id": "abc", "observability": { "enabled": true }, "upload_source_maps": true,
      "placement": { "mode": "smart" }, "compatibility_flags": ["nodejs_compat"], "workers_dev": true,
    }`);
    expect(r.value).toMatchObject({ name: "app", main: "src/index.ts", compatibility_date: "2026-11-23" });
    expect(r.warnings).toEqual([]);
  });

  test("toml reads the same file", () => {
    const r = load(
      `name = "app"\nmain = "src/index.ts"\ncompatibility_date = "2026-11-23"\n[vars]\nA = "b"\n[[kv_namespaces]]\nbinding = "KV"\nid = "x"\n`,
      "wrangler-toml",
    );
    expect(r.ok && r.value.vars).toEqual({ A: "b" });
    expect(r.ok && r.value.kv_namespaces).toEqual(["KV"]);
  });

  test("main may be outside src/, and absent with assets is a Worker with only assets", () => {
    expect(ok(`{ "name": "app", "main": ".open-next/worker.js", "compatibility_date": "2026-11-23" }`).value.main).toBe(
      ".open-next/worker.js",
    );
    const r = ok(`{ "name": "app", "compatibility_date": "2026-11-23", "assets": { "directory": "./public" } }`);
    expect(r.value.main).toBe("src/.assets-only.js");
    expect(r.value.assets).toEqual({ directory: "public", binding: "ASSETS" });
    expect(errors(`{ "name": "app", "compatibility_date": "2026-11-23" }`)).toContain('"main" entry point is required');
  });

  test("errors name the field, the way Wrangler does, and a missing date says what to add", () => {
    expect(errors(`{ ${base}, "kv_namespaces": ["KV"] }`)).toContain(
      '"kv_namespaces" bindings should be objects, but got "KV"',
    );
    expect(errors(`{ ${base}, "vars": 3 }`)).toContain('"vars" should be an object');
    expect(errors(`{ not json`)).toContain("wrangler.jsonc:");
  });

  test("the name must be the Cloud's: long and underscore names say how to keep the file and rename the app", () => {
    expect(
      ok(`{ "name": "${"a".repeat(APP_NAME_MAX)}", "main": "x.ts", "compatibility_date": "2026-11-23" }`).value.name
        .length,
    ).toBe(APP_NAME_MAX);
    const long = errors(
      `{ "name": "${"a".repeat(APP_NAME_MAX + 1)}", "main": "x.ts", "compatibility_date": "2026-11-23" }`,
    );
    expect(long).toContain(`3 to ${APP_NAME_MAX} characters`);
    expect(long).toContain('set "name" in sproutboat.settings.jsonc');
    expect(errors(`{ "name": "my_app", "main": "x.ts", "compatibility_date": "2026-11-23" }`)).toContain(
      "not an app name",
    );
    const named = parseWranglerConfig(
      `{ "name": "my_app", "main": "x.ts", "compatibility_date": "2026-11-23" }`,
      "wrangler-jsonc",
      { name: "my-app" },
    );
    expect(named.ok && named.value.name).toBe("my-app");
  });

  test("an unknown field is a warning, not an error (Wrangler's severity)", () => {
    const r = ok(`{ ${base}, "foo": 1 }`);
    expect(r.warnings).toEqual(['wrangler.jsonc: foo: unknown field "foo" (ignored)']);
  });
});

describe("what Sproutboat does not run says so, once", () => {
  test("products warn per entry, naming the consequence", () => {
    const r =
      ok(`{ ${base}, "ai": { "binding": "AI" }, "hyperdrive": [{ "binding": "H1", "id": "a" }, { "binding": "H2", "id": "b" }],
      "routes": ["x.example.com/*"], "build": { "command": "npm run build" }, "access": { "required": true } }`);
    expect(r.warnings).toEqual(
      expect.arrayContaining([
        "wrangler.jsonc: ai: Workers AI is not supported; env.AI will be undefined",
        expect.stringContaining("hyperdrive[0]"),
        expect.stringContaining("hyperdrive[1]"),
        expect.stringContaining("routes: not applied"),
        expect.stringContaining("build: build.command is not run"),
        expect.stringContaining("access: Cloudflare Access is not applied"),
      ]),
    );
    expect(r.warnings.length).toBe(6);
  });

  test("compatibility flags: the Node ones are silent, others are named", () => {
    expect(
      ok(`{ ${base}, "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"] }`).warnings,
    ).toEqual([]);
    expect(ok(`{ ${base}, "compatibility_flags": ["experimental"] }`).warnings).toEqual([
      'wrangler.jsonc: compatibility_flags: "experimental" is not supported (ignored)',
    ]);
  });

  test("the date is Cloudflare's: an older or missing date runs as the floor, a later one is kept, and nothing warns", () => {
    const old = ok(
      `{ "name": "app", "main": "x.ts", "compatibility_date": "2025-10-08", "d1_databases": [{ "binding": "DB" }] }`,
    );
    expect(old.value.compatibility_date).toBe(WORKERS_COMPAT_FLOOR);
    expect(old.extras.declaredDate).toBe("2025-10-08");
    expect(old.warnings).toEqual([]);
    const later = ok(`{ "name": "app", "main": "x.ts", "compatibility_date": "2027-03-01" }`);
    expect(later.value.compatibility_date).toBe("2027-03-01");
    expect(later.extras.declaredDate).toBeUndefined();
    const missing = ok(`{ "name": "app", "main": "x.ts" }`);
    expect(missing.value.compatibility_date).toBe(WORKERS_COMPAT_FLOOR);
    expect(missing.warnings.join("\n")).toContain(`not set: using ${WORKERS_COMPAT_FLOOR}`);
    expect(errors(`{ "name": "app", "main": "x.ts", "compatibility_date": "yesterday" }`)).toContain("YYYY-MM-DD");
  });
});

describe("bindings", () => {
  test("kv, d1 and r2: Cloudflare ids are not store names yet, so they are dropped with one warning; migrations_dir is per database", () => {
    const r = ok(`{ ${base},
      "kv_namespaces": [{ "binding": "KV", "id": "abc" }],
      "d1_databases": [{ "binding": "DB", "database_name": "n", "database_id": "uuid", "migrations_dir": "sql" }],
      "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "b", "jurisdiction": "eu" }] }`);
    expect(r.value.kv_namespaces).toEqual(["KV"]);
    expect(r.value.d1_databases).toEqual(["DB"]);
    expect(r.value.r2_buckets).toEqual(["BUCKET"]);
    expect(r.extras.migrationsDirs).toEqual({ DB: "sql" });
    expect(r.warnings.join("\n")).toContain(
      "kv_namespaces.KV, d1_databases.DB, r2_buckets.BUCKET: have Cloudflare ids",
    );
    expect(r.warnings.join("\n")).toContain("jurisdiction");
  });

  test("a store spelled two ways is refused (the Cloud lowercases the name)", () => {
    expect(errors(`{ ${base}, "kv_namespaces": [{ "binding": "Data" }, { "binding": "DATA" }] }`)).toContain(
      "differ only in case",
    );
  });

  test("vars keep their JSON type and may have any identifier name", () => {
    const r = ok(`{ ${base}, "vars": { "limit": 5, "flag": true, "OBJ": { "a": [1] } } }`);
    expect(JSON.stringify(r.value.vars)).toBe(JSON.stringify({ limit: 5, flag: true, OBJ: { a: [1] } }));
    expect(errors(`{ ${base}, "vars": { "bad-name": 1 } }`)).toContain("JavaScript identifier");
    expect(errors(`{ ${base}, "vars": { "A": 1 }, "secrets": { "required": ["A"] } }`)).toContain('"A" is used twice');
  });

  test("secrets.required declares secrets", () => {
    expect(ok(`{ ${base}, "secrets": { "required": ["API_KEY"] } }`).value.secrets).toEqual(["API_KEY"]);
  });

  test("durable objects: bindings plus migrations; another Worker's class and data moves warn", () => {
    const r =
      ok(`{ ${base}, "durable_objects": { "bindings": [{ "name": "C", "class_name": "Counter" }, { "name": "R", "class_name": "Remote", "script_name": "other" }] },
      "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }, { "tag": "v2", "renamed_classes": [{ "from": "A", "to": "B" }] }] }`);
    expect(r.value.durable_objects).toEqual({ C: "Counter", R: "Remote" });
    expect(r.warnings.join("\n")).toContain("durable_objects.bindings.R.script_name");
    expect(r.warnings.join("\n")).toContain("migrations.renamed_classes");
  });

  test("services, ratelimits, analytics, version metadata and assets map to today's shapes", () => {
    const r = ok(`{ ${base},
      "services": [{ "binding": "PEER", "service": "other-app" }, { "binding": "E", "service": "x-app", "entrypoint": "Api" }],
      "ratelimits": [{ "name": "LIMITER", "namespace_id": "1", "simple": { "limit": 10, "period": 60 } }],
      "analytics_engine_datasets": [{ "binding": "AE", "dataset": "d" }],
      "version_metadata": { "binding": "VER" },
      "assets": { "directory": "./dist", "binding": "A", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*", "!/api/health", "/x/*/y"], "html_handling": "none" } }`);
    expect(r.value.services).toEqual([
      { binding: "PEER", service: "other-app" },
      { binding: "E", service: "x-app" },
    ]);
    expect(r.value.ratelimiters).toEqual([{ binding: "LIMITER", limit: 10, period: 60 }]);
    expect(r.value.analytics_engine_datasets).toEqual(["AE"]);
    expect(r.value.version_metadata).toBe("VER");
    expect(r.value.assets).toEqual({
      directory: "dist",
      binding: "A",
      not_found_handling: "single-page-application",
      run_sprout_first: ["/api/**", "!/api/health", "/x/**/y"],
    });
    expect(r.warnings.join("\n")).toContain("services[1].entrypoint");
    expect(r.warnings.join("\n")).toContain("assets.html_handling");
  });

  test("assets without a directory (a build tool writes it) is an error that says so", () => {
    expect(errors(`{ ${base}, "assets": { "binding": "ASSETS" } }`)).toContain("Cloudflare Vite plugin");
  });
});

describe("queues: a queue is consumed only when it is listed under consumers", () => {
  test("producers and consumers pair by queue name; a producer alone is not consumed; a consumer alone still is", () => {
    const r = ok(`{ ${base}, "queues": {
      "producers": [{ "binding": "JOBS", "queue": "jobs" }, { "binding": "AUDIT", "queue": "audit" }],
      "consumers": [{ "queue": "jobs", "max_batch_size": 5, "max_retries": 2, "dead_letter_queue": "dead", "max_concurrency": 3 }, { "queue": "orphan" }] } }`);
    expect(JSON.parse(JSON.stringify(r.value.queues))).toEqual([
      { binding: "JOBS", queue: "jobs", max_batch_size: 5, max_retries: 2, dead_letter_queue: "dead" },
      { binding: "AUDIT", queue: "audit", consume: false },
      { binding: "ORPHAN", queue: "orphan" },
    ]);
    expect(r.warnings).toEqual([]);
  });

  test("a producer with no queue name uses the lowercased binding; delivery_delay warns", () => {
    const r = ok(`{ ${base}, "queues": { "producers": [{ "binding": "EMAILS", "delivery_delay": 5 }] } }`);
    expect(JSON.parse(JSON.stringify(r.value.queues))).toEqual([
      { binding: "EMAILS", queue: "emails", consume: false },
    ]);
    expect(r.warnings.join("\n")).toContain("delivery_delay");
  });
});

describe("environments (Wrangler's rules)", () => {
  const file = `{ ${base}, "compatibility_flags": ["nodejs_compat"],
    "vars": { "MODE": "prod" }, "kv_namespaces": [{ "binding": "KV" }], "triggers": { "crons": ["0 * * * *"] },
    "env": {
      "staging": { "vars": { "MODE": "staging" }, "kv_namespaces": [{ "binding": "KV" }] },
      "custom": { "name": "other-name", "vars": { "MODE": "c" } },
    } }`;

  test("the top level without --env", () => {
    expect(ok(file).value).toMatchObject({ name: "app", vars: { MODE: "prod" } });
  });

  test("--env: the name gets -<env>, inheritable fields are inherited, the others are the env's", () => {
    const r = ok(file, "staging");
    expect(r.value.name).toBe("app-staging");
    expect(r.value.vars).toEqual({ MODE: "staging" });
    expect(r.value.triggers).toEqual({ crons: ["0 * * * *"] });
    expect(r.extras.env).toBe("staging");
  });

  test("a field that is not inherited and missing in the env draws Wrangler's warning, word for word", () => {
    const r = ok(file, "custom");
    expect(r.value.name).toBe("other-name");
    expect(r.value.kv_namespaces).toBeUndefined();
    expect(r.warnings).toContain(
      'wrangler.jsonc: kv_namespaces: "kv_namespaces" exists at the top level, but not on "env.custom". This is not what you probably want, since "kv_namespaces" is not inherited by environments. Please add "kv_namespaces" to "env.custom".',
    );
  });

  test("an env that is not defined is an error when the file defines others, a warning when it defines none", () => {
    expect(errors(file, "nope")).toContain('No environment found in configuration with name "nope"');
    expect(ok(`{ ${base} }`, "nope").warnings.join("\n")).toContain("no environments are defined");
  });

  test("the suffix counts against the Cloud's limit", () => {
    expect(
      errors(
        `{ "name": "${"a".repeat(APP_NAME_MAX - 4)}", "main": "x.ts", "compatibility_date": "2026-11-23", "env": { "staging": {} } }`,
        "staging",
      ),
    ).toContain('the "-staging" suffix counts');
  });
});

describe("a config a build tool generated (.wrangler/deploy/config.json)", () => {
  const generated = `{ "topLevelName": "app", "definedEnvironments": [], "configPath": "/x/wrangler.jsonc", "userConfigPath": "/x/wrangler.jsonc",
    "compatibility_date": "2025-10-08", "rules": [{ "type": "ESModule", "globs": ["**/*.js", "**/*.mjs"] }], "python_modules": { "exclude": ["**/*.pyc"] },
    "name": "app", "main": "index.js", "assets": { "binding": "ASSETS", "directory": "../client" }, "kv_namespaces": [], "hyperdrive": [], "cloudchamber": {} }`;

  test("paths are rebased onto the project, the plugin's own fields and Wrangler's defaults are silent", () => {
    const r = parseWranglerConfig(generated, "wrangler-json", {
      file: "wrangler.json",
      redirected: { prefix: "dist/app" },
    });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r.value.main).toBe("dist/app/index.js");
    expect(r.value.assets).toMatchObject({ directory: "dist/client", binding: "ASSETS" });
    expect(r.warnings).toEqual([]);
  });

  test("read as the user's own file, the generated folder is outside the project; a file that leaves assets.directory to the build says to build first", () => {
    const r = parseWranglerConfig(generated, "wrangler-json", { file: "wrangler.json" });
    expect(r.ok).toBe(false);
    expect(errors(`{ ${base}, "assets": { "binding": "ASSETS" } }`)).toContain("run your build first");
  });
});

describe("limits, dev and workers_dev", () => {
  test("limits.cpu_ms, dev.port/ip and workers_dev are read", () => {
    const r = ok(
      `{ ${base}, "limits": { "cpu_ms": 500, "subrequests": 10 }, "dev": { "port": 9000, "ip": "0.0.0.0" }, "workers_dev": false }`,
    );
    expect(r.extras).toMatchObject({ cpuMs: 500, dev: { port: 9000, ip: "0.0.0.0" }, workersDev: false });
    expect(errors(`{ ${base}, "limits": { "cpu_ms": 1 } }`)).toContain("10 to 600000");
  });
});

test("database_name of a d1_databases entry maps to its binding, for `d1 migrations apply <database_name>`", () => {
  const r = ok(
    `{ ${base}, "d1_databases": [{ "binding": "AuthDb", "database_name": "auth-db", "database_id": "x" }] }`,
  );
  expect(r.extras.d1Names).toEqual({ "auth-db": "AuthDb" });
  expect(r.value.d1_databases).toEqual(["AuthDb"]);
});
