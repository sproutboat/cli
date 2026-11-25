import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialectOf, findProjectFile, findRedirect, loadProjectText, readSettings } from "./project-config";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "project-config-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (dir: string, name: string, text = "{}") => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
};

describe("which file is the project", () => {
  test("Wrangler's order in one directory, the legacy file last", () => {
    const dir = join(root, "order");
    put(dir, "sproutboat.jsonc");
    expect(findProjectFile(dir)).toMatchObject({ dialect: "legacy", shadowed: [] });
    put(dir, "wrangler.toml");
    expect(findProjectFile(dir)).toMatchObject({
      configPath: join(dir, "wrangler.toml"),
      dialect: "wrangler",
      shadowed: ["sproutboat.jsonc"],
    });
    put(dir, "wrangler.jsonc");
    expect(findProjectFile(dir)?.configPath).toBe(join(dir, "wrangler.jsonc"));
    put(dir, "wrangler.json");
    expect(findProjectFile(dir)).toMatchObject({
      configPath: join(dir, "wrangler.json"),
      shadowed: ["wrangler.jsonc", "wrangler.toml", "sproutboat.jsonc"],
    });
  });

  test("the search walks up directory by directory, so the nearest directory with any project file wins", () => {
    const parent = join(root, "walk");
    put(parent, "wrangler.json");
    const child = join(parent, "packages", "app");
    put(child, "wrangler.jsonc");
    expect(findProjectFile(child)?.configPath).toBe(join(child, "wrangler.jsonc"));
    mkdirSync(join(parent, "other", "deep"), { recursive: true });
    expect(findProjectFile(join(parent, "other", "deep"))?.directory).toBe(parent);
  });

  test("nothing found is undefined", () => {
    const dir = join(root, "none");
    mkdirSync(dir);
    const found = findProjectFile(dir, () => false);
    expect(found).toBeUndefined();
  });

  test("-c: exactly sproutboat.jsonc is legacy; the settings file is never a project file", () => {
    expect(dialectOf("sproutboat.jsonc")).toBe("legacy");
    expect(dialectOf("sub/wrangler.standalone.jsonc")).toBe("wrangler");
    expect(dialectOf("wrangler.toml")).toBe("wrangler");
    expect(dialectOf("sproutboat.settings.jsonc")).toBe("unknown");
    expect(dialectOf("sproutboat.standalone.jsonc")).toBe("wrangler");
    expect(dialectOf("notes.txt")).toBe("unknown");
    const refused = loadProjectText("sproutboat.settings.jsonc", "{}", { directory: root });
    expect(refused.ok ? "" : refused.errors[0]).toContain("is not a project file");
  });
});

describe("the redirect a build tool writes", () => {
  test("a pointer to a generated config gives its path and its folder as seen from the project", () => {
    const dir = join(root, "redirect");
    put(dir, "wrangler.jsonc");
    put(join(dir, "dist", "app"), "wrangler.json");
    put(
      join(dir, ".wrangler", "deploy"),
      "config.json",
      JSON.stringify({ configPath: "../../dist/app/wrangler.json" }),
    );
    expect(findRedirect(dir)).toEqual({
      ok: true,
      redirect: {
        path: join(dir, "dist", "app", "wrangler.json"),
        prefix: "dist/app",
        display: "dist/app/wrangler.json",
      },
    });
  });

  test("no pointer is no redirect; a pointer to a missing or outside file is an error that says what to do", () => {
    const none = join(root, "no-redirect");
    mkdirSync(none);
    expect(findRedirect(none)).toEqual({ ok: true, redirect: undefined });
    const gone = join(root, "gone");
    put(join(gone, ".wrangler", "deploy"), "config.json", JSON.stringify({ configPath: "../../dist/x/wrangler.json" }));
    const missing = findRedirect(gone);
    expect(!missing.ok && missing.error).toContain("run your build again");
    const outside = join(root, "outside");
    put(outside, "wrangler.jsonc");
    put(
      join(outside, ".wrangler", "deploy"),
      "config.json",
      JSON.stringify({ configPath: join(root, "redirect", "dist", "app", "wrangler.json") }),
    );
    const away = findRedirect(outside);
    expect(!away.ok && away.error).toContain("outside the project");
  });
});

describe("sproutboat.settings.jsonc", () => {
  test("absent means defaults", () => {
    const dir = join(root, "no-settings");
    mkdirSync(dir);
    const r = readSettings(dir, undefined, {});
    expect(r.ok && r.settings).toMatchObject({ limits: {}, from: {} });
  });

  test("team, name and limits, with env blocks replacing key by key", () => {
    const dir = join(root, "settings");
    put(
      dir,
      "sproutboat.settings.jsonc",
      `{ // ours
        "$schema": "https://sproutboat.com/settings.schema.json",
        "account": "acme", "name": "short-name", "limits": { "memory_mb": 64, "wall_ms": 30000 },
        "env": { "staging": { "account": "acme-staging", "limits": { "memory_mb": 32 } } } }`,
    );
    const top = readSettings(dir, undefined, {});
    expect(top.ok && top.settings).toMatchObject({
      account: "acme",
      name: "short-name",
      limits: { memory_mb: 64, wall_ms: 30000 },
    });
    const staging = readSettings(dir, "staging", {});
    expect(staging.ok && staging.settings).toMatchObject({
      account: "acme-staging",
      limits: { memory_mb: 32, wall_ms: 30000 },
    });
    expect(staging.ok && staging.settings.from.memory_mb).toBe("sproutboat.settings.jsonc env.staging");
  });

  test("an environment variable overrides the file, and says where the value came from", () => {
    const dir = join(root, "override");
    put(dir, "sproutboat.settings.jsonc", `{ "limits": { "memory_mb": 64 } }`);
    const r = readSettings(dir, undefined, { SPROUTBOAT_LIMITS_MEMORY_MB: "128", SPROUTBOAT_LIMITS_WALL_MS: "5000" });
    expect(r.ok && r.settings.limits).toEqual({ memory_mb: 128, wall_ms: 5000 });
    expect(r.ok && r.settings.from.memory_mb).toBe("SPROUTBOAT_LIMITS_MEMORY_MB");
  });

  test("strict: an unknown key and an out-of-range value are errors that name the Cloud's range", () => {
    const dir = join(root, "strict");
    put(
      dir,
      "sproutboat.settings.jsonc",
      `{ "foo": 1, "limits": { "memory_mb": 1, "colour": 2 }, "account": "Bad Name" }`,
    );
    const r = readSettings(dir, undefined, {});
    const text = r.ok ? "" : r.errors.join("\n");
    expect(text).toContain('unknown key "foo"');
    expect(text).toContain("limits.memory_mb must be an integer from 8 to 4096");
    expect(text).toContain("unknown limit limits.colour");
    expect(text).toContain("account must be the URL name of a team");
    const bad = readSettings(root, undefined, { SPROUTBOAT_LIMITS_WALL_MS: "5" });
    expect(bad.ok ? "" : bad.errors[0]).toContain("SPROUTBOAT_LIMITS_WALL_MS must be an integer from 100 to 600000");
  });
});

describe("one loader for both dialects", () => {
  test("a Wrangler file brings the team and limits from the settings file, plus Wrangler's own cpu_ms", () => {
    const dir = join(root, "wrangler-settings");
    put(dir, "sproutboat.settings.jsonc", `{ "account": "acme", "name": "tidy", "limits": { "storage_mb": 10 } }`);
    const r = loadProjectText(
      "wrangler.jsonc",
      `{ "name": "aaaaa-name-longer-than-the-cloud-takes-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "main": "x.ts", "compatibility_date": "2026-11-23", "limits": { "cpu_ms": 100 }, "workers_dev": false }`,
      { directory: dir, inherited: {} },
    );
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r).toMatchObject({
      dialect: "wrangler",
      account: "acme",
      workersDev: false,
      limits: { storage_mb: 10, cpu_ms: 100 },
    });
    expect(r.value.name).toBe("tidy");
    expect(r.limitSources.cpu_ms).toBe("wrangler.jsonc limits.cpu_ms");
  });

  test("the legacy file keeps its own account, migrations_dir and workers_dev, and has no limits", () => {
    const r = loadProjectText(
      "sproutboat.jsonc",
      `{ "name": "legacy", "main": "src/index.ts", "compatibility_date": "2026-11-23", "account": "old", "migrations_dir": "sql", "d1_databases": ["DB"] }`,
      { directory: root },
    );
    if (!r.ok) throw new Error(r.errors.join("\n"));
    expect(r).toMatchObject({ dialect: "legacy", account: "old", migrationsDir: "sql", limits: {} });
    expect(r.value.d1_databases).toEqual(["DB"]);
  });
});
