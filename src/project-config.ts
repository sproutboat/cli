/**
 * Which file is the project's config. Wrangler's files are native; `sproutboat.jsonc` is legacy and keeps working. The
 * team, the app name and the limits live beside the config in `sproutboat.settings.jsonc`, so Wrangler's file stays stock.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { SproutboatConfig } from "@sproutboat/config";
import { parseProjectConfig, configAccount, configMigrationsDir, configWorkersDev } from "./account-field";
import { isString, jsonObject, type JsonObject, type JsonValue } from "./json";
import {
  APP_NAME_MAX,
  parseWranglerConfig,
  PROJECT_RE as PROJECT_NAME_RE,
  wranglerKind,
  type WranglerExtras,
} from "./wrangler-config";

/** In one directory, in this order (Wrangler's, then the legacy file). */
export const PROJECT_FILES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml", "sproutboat.jsonc"] as const;
export const LEGACY_FILE = "sproutboat.jsonc";
export const SETTINGS_FILE = "sproutboat.settings.jsonc";

export type Found = { directory: string; configPath: string; dialect: "wrangler" | "legacy"; shadowed: string[] };

/** The first directory (the start, then each parent) that holds one of the four files; the first of the four in it. */
export function findProjectFile(start: string, exists: (path: string) => boolean = existsSync): Found | undefined {
  let directory = resolve(start);
  for (;;) {
    const present = PROJECT_FILES.filter((name) => exists(join(directory, name)));
    if (present.length > 0) {
      const first = present[0]!;
      return {
        directory,
        configPath: join(directory, first),
        dialect: first === LEGACY_FILE ? "legacy" : "wrangler",
        shadowed: present.slice(1),
      };
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** `-c <file>`: exactly `sproutboat.jsonc` is the legacy dialect; any other .json, .jsonc or .toml is Wrangler's. */
export function dialectOf(configPath: string): "wrangler" | "legacy" | "unknown" {
  const name = basename(configPath);
  if (name === LEGACY_FILE) return "legacy";
  if (name === SETTINGS_FILE) return "unknown";
  return wranglerKind(name) === undefined ? "unknown" : "wrangler";
}

/**
 * Wrangler's redirected configuration: a build tool (the Cloudflare Vite plugin) writes `.wrangler/deploy/config.json` with the
 * `configPath` of the config it generated, and that file, not the user's, is what a deploy reads. Its paths are relative to its
 * own folder, so `prefix` is that folder as seen from the project.
 */
export type Redirect = { path: string; prefix: string; display: string };
export function findRedirect(
  directory: string,
): { ok: true; redirect: Redirect | undefined } | { ok: false; error: string } {
  const pointer = join(directory, ".wrangler", "deploy", "config.json");
  let raw: JsonValue | undefined;
  try {
    raw = parseJsonc(readFileSync(pointer, "utf8"), [], { allowTrailingComma: true });
  } catch {
    return { ok: true, redirect: undefined };
  }
  const configPath = isRec(raw) ? raw.configPath : undefined;
  if (!isString(configPath) || configPath === "") return { ok: true, redirect: undefined };
  const path = resolve(dirname(pointer), configPath);
  if (!existsSync(path))
    return {
      ok: false,
      error: `.wrangler/deploy/config.json points at ${configPath}, which does not exist: run your build again`,
    };
  const prefix = relative(directory, dirname(path)).split(sep).join("/");
  if (prefix.startsWith(".."))
    return { ok: false, error: `.wrangler/deploy/config.json points at ${path}, outside the project` };
  return { ok: true, redirect: { path, prefix, display: relative(directory, path).split(sep).join("/") } };
}

export type Limits = { memory_mb?: number; wall_ms?: number; storage_mb?: number; cpu_ms?: number };

export type Settings = {
  account?: string;
  /** The app's name on the Cloud, for a Wrangler file whose own name is not a valid one (3 to 51 of a-z, 0-9, -). */
  name?: string;
  limits: Limits;
  /** Where each effective value came from, for the deploy report. */
  from: Record<string, string>;
  path?: string;
};

const LIMIT_RANGES = {
  memory_mb: [8, 4096],
  wall_ms: [100, 600_000],
  storage_mb: [1, 1_048_576],
} as const;
const LIMIT_BY_NAME = new Map<string, readonly [number, number]>(Object.entries(LIMIT_RANGES));
const ACCOUNT_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

type JsonRec = JsonObject;
const isRec = (value: JsonValue | undefined): value is JsonRec =>
  value !== undefined && jsonObject(value) !== undefined;

/**
 * `sproutboat.settings.jsonc`: optional and strict (an unknown key is an error). `env.<name>` replaces keys for that
 * environment; `SPROUTBOAT_LIMITS_*` variables override the file.
 */
export function readSettings(
  directory: string,
  env: string | undefined,
  inherited: Record<string, string | undefined> = process.env,
): { ok: true; settings: Settings } | { ok: false; errors: string[] } {
  const path = join(directory, SETTINGS_FILE);
  const settings: Settings = { limits: {}, from: {} };
  const errors: string[] = [];
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = undefined;
  }
  if (text !== undefined) {
    settings.path = path;
    const parseErrors: ParseError[] = [];
    const raw: JsonValue | undefined = parseJsonc(text, parseErrors, { allowTrailingComma: true });
    if (parseErrors.length > 0 || !isRec(raw)) return { ok: false, errors: [`${SETTINGS_FILE}: not valid JSONC`] };
    const apply = (block: JsonRec, where: string, label: string) => {
      for (const key of Object.keys(block)) {
        if (key === "$schema" && where === "") continue;
        if (key === "env" && where === "") continue;
        if (key !== "account" && key !== "limits" && key !== "name")
          errors.push(`${SETTINGS_FILE}: unknown key ${where}${JSON.stringify(key)}`);
      }
      if (block.account !== undefined) {
        if (isString(block.account) && ACCOUNT_RE.test(block.account)) {
          settings.account = block.account;
          settings.from.account = label;
        } else
          errors.push(
            `${SETTINGS_FILE}: ${where}account must be the URL name of a team (lowercase letters, digits and dashes)`,
          );
      }
      if (block.name !== undefined) {
        if (isString(block.name) && PROJECT_NAME_RE.test(block.name)) {
          settings.name = block.name;
          settings.from.name = label;
        } else
          errors.push(
            `${SETTINGS_FILE}: ${where}name must be 3 to ${APP_NAME_MAX} characters: lowercase letters, digits and dashes`,
          );
      }
      if (block.limits !== undefined) {
        if (!isRec(block.limits)) errors.push(`${SETTINGS_FILE}: ${where}limits must be an object`);
        else
          for (const [key, value] of Object.entries(block.limits)) {
            const range = LIMIT_BY_NAME.get(key);
            if (range === undefined)
              errors.push(
                `${SETTINGS_FILE}: unknown limit ${where}limits.${key} (memory_mb, wall_ms, storage_mb; cpu_ms is Wrangler's limits.cpu_ms)`,
              );
            else if (Number(value) !== value || !Number.isInteger(value) || value < range[0] || value > range[1])
              errors.push(
                `${SETTINGS_FILE}: ${where}limits.${key} must be an integer from ${range[0]} to ${range[1]} (the Cloud's range)`,
              );
            else {
              Object.assign(settings.limits, { [key]: value });
              settings.from[key] = label;
            }
          }
      }
    };
    apply(raw, "", SETTINGS_FILE);
    if (raw.env !== undefined) {
      if (!isRec(raw.env)) errors.push(`${SETTINGS_FILE}: env must be an object`);
      else if (env !== undefined && raw.env[env] !== undefined) {
        const block = raw.env[env];
        if (isRec(block)) apply(block, `env.${env}.`, `${SETTINGS_FILE} env.${env}`);
        else errors.push(`${SETTINGS_FILE}: env.${env} must be an object`);
      }
    }
  }
  for (const [key, variable] of [
    ["memory_mb", "SPROUTBOAT_LIMITS_MEMORY_MB"],
    ["wall_ms", "SPROUTBOAT_LIMITS_WALL_MS"],
    ["storage_mb", "SPROUTBOAT_LIMITS_STORAGE_MB"],
  ] as const) {
    const given = inherited[variable];
    if (given === undefined || given === "") continue;
    const value = Number(given);
    const range = LIMIT_RANGES[key];
    if (!Number.isInteger(value) || value < range[0] || value > range[1])
      errors.push(
        `${variable} must be an integer from ${range[0]} to ${range[1]} (the Cloud's range), but is ${JSON.stringify(given)}`,
      );
    else {
      settings.limits[key] = value;
      settings.from[key] = variable;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings };
}

export type LoadedProject =
  | {
      ok: true;
      dialect: "wrangler" | "legacy";
      value: SproutboatConfig;
      warnings: string[];
      account: string | undefined;
      migrationsDir: string | undefined;
      migrationsDirs: Record<string, string>;
      workersDev: boolean | undefined;
      limits: Limits;
      limitSources: Record<string, string>;
      dev: WranglerExtras["dev"];
      env: string | undefined;
      declaredDate: string | undefined;
    }
  | { ok: false; errors: string[] };

/**
 * Parse one config file's text in the dialect its name says. `env` is `--env` or `CLOUDFLARE_ENV`; the legacy dialect has no
 * environments, so it ignores it (the caller refuses an explicit `--env` for it).
 */
export function loadProjectText(
  fileName: string,
  text: string,
  options: {
    directory: string;
    env?: string;
    inherited?: Record<string, string | undefined>;
    redirected?: { prefix: string };
  },
): LoadedProject {
  const dialect = dialectOf(fileName);
  if (dialect === "unknown")
    return {
      ok: false,
      errors: [
        fileName === SETTINGS_FILE
          ? `${SETTINGS_FILE} holds Sproutboat's team and limits; it is not a project file. Point -c at your wrangler.jsonc.`
          : `${fileName}: not a config file Sproutboat reads (wrangler.json, wrangler.jsonc, wrangler.toml; sproutboat.jsonc is the legacy file)`,
      ],
    };
  if (dialect === "legacy") {
    if (basename(fileName) !== LEGACY_FILE) return { ok: false, errors: [`${fileName}: not the legacy file name`] };
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) return { ok: false, errors: parsed.errors };
    return {
      ok: true,
      dialect,
      value: parsed.value,
      warnings: parsed.warnings,
      account: configAccount(text),
      migrationsDir: configMigrationsDir(text),
      migrationsDirs: {},
      workersDev: configWorkersDev(text),
      limits: {},
      limitSources: {},
      dev: undefined,
      env: undefined,
      declaredDate: undefined,
    };
  }
  const kind = wranglerKind(fileName);
  if (kind === undefined) return { ok: false, errors: [`${fileName}: not a config file Sproutboat reads`] };
  const settings = readSettings(options.directory, options.env, options.inherited);
  if (!settings.ok) return settings;
  const loaded = parseWranglerConfig(text, kind, {
    file: basename(fileName),
    env: options.env,
    name: settings.settings.name,
    redirected: options.redirected,
  });
  if (!loaded.ok) return loaded;
  const limits: Limits = { ...settings.settings.limits };
  const limitSources = { ...settings.settings.from };
  if (loaded.extras.cpuMs !== undefined) {
    limits.cpu_ms = loaded.extras.cpuMs;
    limitSources.cpu_ms = `${basename(fileName)} limits.cpu_ms`;
  }
  return {
    ok: true,
    dialect,
    value: loaded.value,
    warnings: loaded.warnings,
    account: settings.settings.account,
    migrationsDir: undefined,
    migrationsDirs: loaded.extras.migrationsDirs,
    workersDev: loaded.extras.workersDev,
    limits,
    limitSources,
    dev: loaded.extras.dev,
    env: loaded.extras.env,
    declaredDate: loaded.extras.declaredDate,
  };
}
