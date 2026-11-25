/**
 * Conformance with Cloudflare's own files: every project file of cloudflare/templates (vendored, unchanged) goes through the
 * Wrangler front end, and the Wrangler field table must cover exactly the fields Wrangler's own schema has.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { jsonObject, parseJsonValue } from "./json";
import { FIELD_TABLE, parseWranglerConfig, wranglerKind } from "./wrangler-config";

const root = join(import.meta.dir, "..", "test", "fixtures", "cloudflare-templates");
const files = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((dir) =>
    readdirSync(join(root, dir.name))
      .filter((name) => wranglerKind(name) !== undefined)
      .map((name) => join(dir.name, name)),
  )
  .sort();

// The files whose build tool, not the file, names the assets folder (the Cloudflare Vite plugin writes it).
const BUILD_TOOL_ASSETS = [
  "react-postgres-fullstack-template/wrangler.jsonc",
  "react-router-postgres-ssr-template/wrangler.jsonc",
  "react-starter-template/wrangler.json",
];

test("the vendored set holds all 41 files", () => {
  expect(files.length).toBe(41);
});

test("every Cloudflare template loads, with the app name the settings file would give (3 of 41 need their build tool's assets folder first)", () => {
  const refused: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const loaded = parseWranglerConfig(text, wranglerKind(file)!, { file: basename(file), name: "app-name" });
    if (!loaded.ok) {
      refused.push(file);
      expect(loaded.errors.join("\n"), file).toContain("assets.directory");
    }
  }
  expect(refused).toEqual(BUILD_TOOL_ASSETS);
});

test("the names Cloudflare ships that are not 3 to 32 characters fail with the Cloud's rule and the way out", () => {
  const long = files.filter((file) => {
    const loaded = parseWranglerConfig(readFileSync(join(root, file), "utf8"), wranglerKind(file)!, { file });
    return !loaded.ok && loaded.errors.some((error) => error.includes("not an app name here"));
  });
  expect(long.length).toBe(5);
  const first = parseWranglerConfig(readFileSync(join(root, long[0]!), "utf8"), wranglerKind(long[0]!)!, {});
  expect(first.ok ? "" : first.errors.join("\n")).toContain('set "name" in sproutboat.settings.jsonc');
});

test("warnings: the products Sproutboat does not run say so, and the fields every file carries stay silent", () => {
  const seen: Record<string, string[]> = {};
  for (const file of files) {
    const loaded = parseWranglerConfig(readFileSync(join(root, file), "utf8"), wranglerKind(file)!, {
      file: basename(file),
      name: "app-name",
    });
    if (loaded.ok)
      for (const warning of loaded.warnings)
        (seen[warning.replace(/^[^:]+: ([^:]+):.*$/, "$1").replace(/\[\d+\]|\..*$/, "")] ??= []).push(file);
  }
  // none of these appear in 41 of 41 files, so none may warn
  for (const silent of ["observability", "upload_source_maps", "placement", "workers_dev"])
    expect(Object.keys(seen)).not.toContain(silent);
  expect(Object.keys(seen)).toEqual(
    expect.arrayContaining([
      "ai",
      "hyperdrive",
      "containers",
      "dispatch_namespaces",
      "workflows",
      "compatibility_date",
    ]),
  );
  expect(seen.ai!.length).toBe(7);
});

test("the field table classifies exactly the top-level fields of Wrangler's own schema", () => {
  const schemaPath = join(import.meta.dir, "..", "node_modules", "wrangler", "config-schema.json");
  if (!existsSync(schemaPath)) return;
  const properties = jsonObject(
    jsonObject(jsonObject(parseJsonValue(readFileSync(schemaPath, "utf8")))?.definitions ?? null)?.RawConfig ?? null,
  )?.properties;
  const wrangler = Object.keys(jsonObject(properties ?? null) ?? {}).sort();
  expect(wrangler.length).toBeGreaterThan(80);
  expect([...FIELD_TABLE.keys()].sort()).toEqual(wrangler);
});
