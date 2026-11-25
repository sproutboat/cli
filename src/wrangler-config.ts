/**
 * Wrangler's files (wrangler.json, .jsonc, .toml) as the native config: a second front end that yields the same
 * normalized `SproutboatConfig` as the legacy parser. A wrong type is an error, an unknown field a warning, as in Wrangler.
 */
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import type { QueueBinding, ResourceRef, SproutboatConfig } from "@sproutboat/config";
import { isBoolean, isString, jsonObject, type JsonObject, type JsonValue } from "./json";

export type WranglerKind = "wrangler-json" | "wrangler-jsonc" | "wrangler-toml";

/** The entry of a Worker that has `assets` and no `main`; the CLI writes the file that answers every miss. */
/** From this date Sproutboat behaves like Workers in every way a Cloudflare file can rely on: the handler signature, Promise-returning bindings, Durable Object RPC, queues, service bindings. */
export const WORKERS_COMPAT_FLOOR = "2026-11-22";

/** The longest app name: the daemon takes app ids of 64 characters, and an id is the name, "_" and 12 hex digits. */
export const APP_NAME_MAX = 51;

export const ASSETS_ONLY_ENTRY = "src/.assets-only.js";

type Json = JsonValue;
type Rec = JsonObject;

export type WranglerExtras = {
  /** `workers_dev`: serve the app at its platform name (Wrangler's default is true). */
  workersDev?: boolean;
  /** `limits.cpu_ms` (Wrangler's own field), for the spec. */
  cpuMs?: number;
  /** Per-database `migrations_dir`, by binding. */
  migrationsDirs: Record<string, string>;
  /** `dev.port` and `dev.ip`, the defaults of `sproutboat dev`. */
  dev?: { port?: number; ip?: string };
  /** The file's own `compatibility_date` when it was older than the floor and so not the one the build uses. */
  declaredDate?: string;
  /** The environment that was selected, if any. */
  env?: string;
};

export type WranglerLoad =
  | { ok: true; value: SproutboatConfig; warnings: string[]; extras: WranglerExtras }
  | { ok: false; errors: string[] };

export type WranglerOptions = {
  /** The file name used in messages. */
  file?: string;
  /** `--env` or `CLOUDFLARE_ENV`. */
  env?: string;
  /** The app's name on the Cloud when the file's own name is not one (settings file `name`); replaces `name` after the environment. */
  name?: string;
};

// What each of Wrangler 4.161.0's 91 top-level fields does here (ok: acted on; silent: harmless; warn: a product not run).
// A test fails when a newer Wrangler adds a field that is not classified.
type Disposition = { kind: "ok" } | { kind: "silent" } | { kind: "warn"; message: string };
const OK: Disposition = { kind: "ok" };
const SILENT: Disposition = { kind: "silent" };
const warn = (message: string): Disposition => ({ kind: "warn", message });

export const FIELD_TABLE = new Map(
  Object.entries({
    $schema: OK,
    env: OK,
    durable_objects: OK,
    name: OK,
    account_id: SILENT,
    compatibility_date: OK,
    compatibility_flags: OK,
    main: OK,
    find_additional_modules: SILENT,
    preserve_file_names: SILENT,
    base_dir: SILENT,
    workers_dev: OK,
    preview_urls: SILENT,
    routes: warn("not applied; the app is served at its sproutboat.app name"),
    route: warn("not applied; the app is served at its sproutboat.app name"),
    tsconfig: SILENT,
    jsx_factory: SILENT,
    jsx_fragment: SILENT,
    migrations: OK,
    exports: SILENT,
    triggers: OK,
    limits: OK,
    rules: warn("custom module rules are not applied; an import the bundler cannot resolve fails in the bundle"),
    build: warn("build.command is not run; build your project first, then deploy"),
    no_bundle: SILENT,
    minify: SILENT,
    keep_names: SILENT,
    first_party_worker: SILENT,
    logfwdr: SILENT,
    logpush: SILENT,
    upload_source_maps: SILENT,
    placement: SILENT,
    assets: OK,
    observability: SILENT,
    access: warn("Cloudflare Access is not applied; the app stays public"),
    cache: SILENT,
    compliance_region: warn("data residency is not honoured"),
    python_modules: warn("Python Workers are not supported"),
    previews: SILENT,
    define: warn("compile-time constants are not applied yet"),
    vars: OK,
    secrets: OK,
    workflows: warn("Workflows are not supported"),
    cloudchamber: warn("Cloudchamber is not supported"),
    containers: warn("Containers are not supported"),
    kv_namespaces: OK,
    send_email: warn("send_email bindings are not supported; the binding will be undefined"),
    queues: OK,
    connect: warn("connect bindings are not supported; the binding will be undefined"),
    r2_buckets: OK,
    d1_databases: OK,
    vectorize: warn("Vectorize is not supported; the binding will be undefined"),
    ai_search_namespaces: warn("AI Search is not supported; the binding will be undefined"),
    ai_search: warn("AI Search is not supported; the binding will be undefined"),
    agent_memory: warn("Agent Memory is not supported; the binding will be undefined"),
    hyperdrive: warn("Hyperdrive is not supported; the binding will be undefined"),
    services: OK,
    analytics_engine_datasets: OK,
    browser: warn("Browser Rendering is not supported; the binding will be undefined"),
    analytics: warn("not supported"),
    ai: warn("Workers AI is not supported; env.AI will be undefined"),
    images: warn("Images is not supported; the binding will be undefined"),
    media: warn("Media is not supported; the binding will be undefined"),
    stream: warn("Stream is not supported; the binding will be undefined"),
    version_metadata: OK,
    unsafe: warn("unsafe bindings are not supported"),
    mtls_certificates: warn("mTLS certificates are not supported; the binding will be undefined"),
    tail_consumers: warn("tail consumers are not supported"),
    streaming_tail_consumers: warn("tail consumers are not supported"),
    dispatch_namespaces: warn("Workers for Platforms is not supported; the binding will be undefined"),
    pipelines: warn("Pipelines are not supported; the binding will be undefined"),
    k2: warn("not supported; the binding will be undefined"),
    secrets_store_secrets: warn("Secrets Store is not supported; the binding will be undefined"),
    artifacts: warn("Artifacts are not supported; the binding will be undefined"),
    unsafe_hello_world: warn("not supported; the binding will be undefined"),
    flagship: warn("not supported; the binding will be undefined"),
    ratelimits: OK,
    worker_loaders: warn("Worker Loaders are not supported; the binding will be undefined"),
    vpc_services: warn("VPC services are not supported; the binding will be undefined"),
    vpc_networks: warn("VPC networks are not supported; the binding will be undefined"),
    pages_build_output_dir: warn("this is a Pages project, which Sproutboat does not serve"),
    send_metrics: SILENT,
    dependencies_instrumentation: SILENT,
    dev: OK,
    site: warn("Workers Sites is not supported; use assets"),
    wasm_modules: warn("wasm_modules are not supported"),
    text_blobs: warn("text_blobs are not supported"),
    data_blobs: warn("data_blobs are not supported"),
    alias: warn("alias is not applied by the bundler yet"),
    keep_vars: SILENT,
    addresses: SILENT,
  } satisfies Record<string, Disposition>),
);

/** Fields that exist only at the top level of the file. */
const TOP_ONLY = new Set([
  "$schema",
  "env",
  "pages_build_output_dir",
  "send_metrics",
  "dependencies_instrumentation",
  "dev",
  "site",
  "wasm_modules",
  "text_blobs",
  "data_blobs",
  "alias",
  "keep_vars",
  "addresses",
]);

/** Fields an environment does not inherit: it must repeat them (Wrangler's `normalizeAndValidateEnvironment`). */
const NOT_INHERITED = new Set([
  "define",
  "vars",
  "secrets",
  "durable_objects",
  "workflows",
  "cloudchamber",
  "containers",
  "kv_namespaces",
  "send_email",
  "queues",
  "connect",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "agent_memory",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "browser",
  "analytics",
  "ai",
  "images",
  "media",
  "stream",
  "version_metadata",
  "unsafe",
  "mtls_certificates",
  "tail_consumers",
  "streaming_tail_consumers",
  "dispatch_namespaces",
  "pipelines",
  "k2",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "ratelimits",
  "worker_loaders",
  "vpc_services",
  "vpc_networks",
]);

/** Product fields that are lists of bindings: a warning per entry. */
const LIST_PRODUCTS = new Set([
  "workflows",
  "containers",
  "send_email",
  "connect",
  "vectorize",
  "ai_search_namespaces",
  "ai_search",
  "agent_memory",
  "hyperdrive",
  "mtls_certificates",
  "dispatch_namespaces",
  "pipelines",
  "k2",
  "secrets_store_secrets",
  "artifacts",
  "unsafe_hello_world",
  "flagship",
  "worker_loaders",
  "vpc_services",
  "vpc_networks",
  "wasm_modules",
  "text_blobs",
  "data_blobs",
]);

/** Flags that need nothing here: Node shims are not flag-gated and `fetch` already reaches public addresses only. */
const QUIET_FLAGS = new Set([
  "nodejs_compat",
  "nodejs_compat_v2",
  "nodejs_als",
  "nodejs_compat_populate_process_env",
  "global_fetch_strictly_public",
  "enable_nodejs_process_v2",
  "no_nodejs_compat_v2",
]);

export const PROJECT_RE = new RegExp(`^[a-z0-9](?:[a-z0-9-]{1,${APP_NAME_MAX - 2}}[a-z0-9])?$`);
const BINDING_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CLASS_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const QUEUE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const isRec = (value: JsonValue | undefined): value is Rec => value !== undefined && jsonObject(value) !== undefined;
const isStr = isString;
const isNum = (value: JsonValue | undefined): value is number =>
  value !== undefined && Number(value) === value && Number.isFinite(value);
const q = (value: JsonValue | undefined): string => JSON.stringify(value);

export function wranglerKind(fileName: string): WranglerKind | undefined {
  if (fileName.endsWith(".jsonc")) return "wrangler-jsonc";
  if (fileName.endsWith(".json")) return "wrangler-json";
  if (fileName.endsWith(".toml")) return "wrangler-toml";
  return undefined;
}

export function parseWranglerSource(
  text: string,
  kind: WranglerKind,
): { ok: true; raw: Rec } | { ok: false; error: string } {
  if (kind === "wrangler-toml") {
    try {
      // SAFETY: a TOML file holds the same tables, arrays and scalars as JSON; the dates TOML adds never appear in a Wrangler file.
      const raw = parseToml(text) as Rec;
      return { ok: true, raw };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const errors: ParseError[] = [];
  const raw: JsonValue | undefined = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    const before = text.slice(0, first.offset);
    const line = before.split("\n").length;
    const column = first.offset - before.lastIndexOf("\n");
    return { ok: false, error: `${printParseErrorCode(first.error)} at line ${line}, column ${column}` };
  }
  if (!isRec(raw)) return { ok: false, error: "the file must hold one object" };
  return { ok: true, raw };
}

type Ctx = { file: string; errors: string[]; warnings: Set<string>; at: string };

const err = (ctx: Ctx, message: string) => ctx.errors.push(`${ctx.file}: ${message}`);
const note = (ctx: Ctx, path: string, message: string) => ctx.warnings.add(`${ctx.file}: ${path}: ${message}`);

/** Wrangler's environment merge: inherited fields fall back to the top level, the rest must be repeated in the env. */
function resolveEnvironment(raw: Rec, envName: string | undefined, ctx: Ctx) {
  const envs = raw.env;
  const defined = isRec(envs) ? Object.keys(envs) : [];
  if (envs !== undefined && !isRec(envs)) err(ctx, `"env" should be an object, but got ${q(envs)}`);
  if (envName === undefined) {
    const merged = { ...raw };
    delete merged.env;
    return { merged, envLabel: undefined };
  }
  const section = isRec(envs) ? envs[envName] : undefined;
  if (section === undefined) {
    if (defined.length > 0)
      err(
        ctx,
        `No environment found in configuration with name "${envName}". Before using \`--env=${envName}\` there should be an equivalent environment section in the configuration. The available environments are: ${defined.map(q).join(", ")}`,
      );
    else
      note(
        ctx,
        "env",
        `no environments are defined, so "${envName}" selects nothing; the top level is used (Wrangler does the same)`,
      );
    const merged = { ...raw };
    delete merged.env;
    return { merged, envLabel: undefined };
  }
  if (!isRec(section)) {
    err(ctx, `"env.${envName}" should be an object, but got ${q(section)}`);
    return { merged: { ...raw }, envLabel: envName };
  }
  const merged = { ...raw };
  for (const key of Object.keys(raw)) delete merged[key];
  for (const [key, top] of Object.entries(raw)) {
    if (key === "env") continue;
    if (TOP_ONLY.has(key)) merged[key] = top;
    else if (!NOT_INHERITED.has(key) && key !== "name") merged[key] = top;
  }
  for (const [key, value] of Object.entries(section)) merged[key] = value;
  for (const key of NOT_INHERITED) {
    if (raw[key] !== undefined && section[key] === undefined && !isEmpty(raw[key])) {
      note(
        ctx,
        key,
        `"${key}" exists at the top level, but not on "env.${envName}". This is not what you probably want, since "${key}" is not inherited by environments. Please add "${key}" to "env.${envName}".`,
      );
    }
  }
  const top = isStr(raw.name) ? raw.name : undefined;
  const envNamed = isStr(section.name) ? section.name : top === undefined ? undefined : `${top}-${envName}`;
  if (envNamed === undefined) delete merged.name;
  else merged.name = envNamed;
  return { merged, envLabel: envName };
}

const isEmpty = (value: Json | undefined): boolean =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (isRec(value) && Object.keys(value).length === 0);

function list(ctx: Ctx, field: string, value: Json | undefined): Rec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    err(ctx, `"${field}" should be an array, but got ${q(value)}`);
    return [];
  }
  const out: Rec[] = [];
  for (const entry of value) {
    if (!isRec(entry)) err(ctx, `"${field}" bindings should be objects, but got ${q(entry)}`);
    else out.push(entry);
  }
  return out;
}

function bindingName(ctx: Ctx, field: string, name: Json | undefined, key = "binding"): string | undefined {
  if (!isStr(name)) {
    err(ctx, `"${field}" bindings should have a string "${key}" field, but got ${q(name)}`);
    return undefined;
  }
  if (!BINDING_RE.test(name)) {
    err(
      ctx,
      `"${field}" binding "${name}" must be a JavaScript identifier (letters, digits, "_"; not starting with a digit)`,
    );
    return undefined;
  }
  return name;
}

/** Fields of one binding entry that this implementation does not act on: one warning each when they are set. */
function ignoredKeys(ctx: Ctx, path: string, entry: Rec, known: readonly string[], noisy: Record<string, string>) {
  for (const key of Object.keys(entry)) {
    if (known.includes(key)) continue;
    if (noisy[key] !== undefined) {
      if (key === "remote" && entry[key] !== true) continue;
      note(ctx, `${path}.${key}`, noisy[key]!);
    } else note(ctx, `${path}.${key}`, `unknown field "${key}" (ignored)`);
  }
}

export function convertWrangler(raw: Rec, options: WranglerOptions = {}): WranglerLoad {
  const file = options.file ?? "wrangler.jsonc";
  const ctx: Ctx = { file, errors: [], warnings: new Set(), at: "" };
  const { merged: cfg, envLabel } = resolveEnvironment(raw, options.env, ctx);
  const extras: WranglerExtras = { migrationsDirs: {} };
  if (envLabel !== undefined) extras.env = envLabel;

  for (const key of Object.keys(cfg)) {
    const rule = FIELD_TABLE.get(key);
    if (rule === undefined) {
      note(ctx, key, `unknown field "${key}" (ignored)`);
      continue;
    }
    if (rule.kind !== "warn") continue;
    const value = cfg[key];
    if (isEmpty(value) || value === false) continue;
    if (LIST_PRODUCTS.has(key) && Array.isArray(value)) {
      value.forEach((_, index) => note(ctx, `${key}[${index}]`, rule.message));
    } else if (LIST_PRODUCTS.has(key) && isRec(value)) {
      for (const name of Object.keys(value)) note(ctx, `${key}.${name}`, rule.message);
    } else note(ctx, key, rule.message);
  }

  // name
  let name: string | undefined;
  if (options.name !== undefined) name = options.name;
  else if (!isStr(cfg.name) || cfg.name === "") err(ctx, 'a "name" is required: it is the app\'s name on the Cloud');
  else if (!PROJECT_RE.test(cfg.name))
    err(
      ctx,
      `name ${q(cfg.name)} is not an app name here: the Cloud takes 3 to ${APP_NAME_MAX} characters, lowercase letters, digits and "-" (Wrangler allows more, such as "_" and 63 characters${envLabel ? `; the "-${envLabel}" suffix counts` : ""}). Keep the file as it is and set "name" in sproutboat.settings.jsonc to the app name you want on Sproutboat.`,
    );
  else name = cfg.name;

  // compatibility_date: Cloudflare's date, not Sproutboat's. A Wrangler file always runs with Workers-compatible behaviour
  // (handlers get (request, env, ctx)), so an older or missing date is raised to the floor; a later date is kept.
  let compatibility_date: string | undefined;
  if (cfg.compatibility_date === undefined) {
    compatibility_date = WORKERS_COMPAT_FLOOR;
    note(ctx, "compatibility_date", `not set: using ${WORKERS_COMPAT_FLOOR} (Wrangler also picks a date for you)`);
  } else if (!isStr(cfg.compatibility_date) || !/^\d{4}-\d{2}-\d{2}$/.test(cfg.compatibility_date))
    err(ctx, `compatibility_date must use YYYY-MM-DD, but got ${q(cfg.compatibility_date)}`);
  else {
    compatibility_date = cfg.compatibility_date < WORKERS_COMPAT_FLOOR ? WORKERS_COMPAT_FLOOR : cfg.compatibility_date;
    if (compatibility_date !== cfg.compatibility_date) extras.declaredDate = cfg.compatibility_date;
  }

  // compatibility_flags
  if (cfg.compatibility_flags !== undefined) {
    if (!Array.isArray(cfg.compatibility_flags) || cfg.compatibility_flags.some((flag) => !isStr(flag)))
      err(ctx, `"compatibility_flags" should be an array of strings, but got ${q(cfg.compatibility_flags)}`);
    else
      for (const flag of cfg.compatibility_flags.filter(isString))
        if (!QUIET_FLAGS.has(flag)) note(ctx, "compatibility_flags", `${q(flag)} is not supported (ignored)`);
  }

  // assets
  let assets: SproutboatConfig["assets"];
  if (cfg.assets !== undefined) {
    if (!isRec(cfg.assets)) err(ctx, `"assets" should be an object, but got ${q(cfg.assets)}`);
    else {
      const a = cfg.assets;
      const directory = isStr(a.directory) ? a.directory.replace(/^\.\//, "").replace(/\/+$/, "") : "";
      if (a.directory === undefined)
        err(
          ctx,
          '"assets.directory" is not set: this file leaves it to a build tool (the Cloudflare Vite plugin writes it into the build output and points .wrangler/deploy/config.json at the generated config), which Sproutboat does not follow yet. Set "assets.directory" to your built folder, for example "./dist".',
        );
      else if (directory === "" || directory.split("/").includes(".."))
        err(ctx, `"assets.directory" should be a folder inside the project, but got ${q(a.directory)}`);
      else {
        assets = { directory };
        if (a.binding !== undefined) {
          const binding = bindingName(ctx, "assets", a.binding);
          if (binding !== undefined) assets.binding = binding;
        }
        if (a.not_found_handling !== undefined) {
          if (
            a.not_found_handling === "none" ||
            a.not_found_handling === "single-page-application" ||
            a.not_found_handling === "404-page"
          )
            assets.not_found_handling = a.not_found_handling;
          else
            err(
              ctx,
              `"assets.not_found_handling" should be "none", "single-page-application" or "404-page", but got ${q(a.not_found_handling)}`,
            );
        }
        if (a.run_worker_first !== undefined) {
          const first = a.run_worker_first;
          if (isBoolean(first)) assets.run_sprout_first = first;
          else if (Array.isArray(first) && first.every((p) => isStr(p) && /^!?\//.test(p)))
            assets.run_sprout_first = first.filter(isString);
          else
            err(
              ctx,
              `"assets.run_worker_first" should be a boolean or an array of route patterns starting with "/" or "!/", but got ${q(first)}`,
            );
        }
        if (a.html_handling !== undefined && a.html_handling !== "auto-trailing-slash")
          note(ctx, "assets.html_handling", `${q(a.html_handling)} is not supported; "auto-trailing-slash" is used`);
        if (a.base_path !== undefined) note(ctx, "assets.base_path", "not supported (ignored)");
        for (const key of Object.keys(a))
          if (
            !["directory", "binding", "not_found_handling", "run_worker_first", "html_handling", "base_path"].includes(
              key,
            )
          )
            note(ctx, `assets.${key}`, `unknown field "${key}" (ignored)`);
      }
    }
  }

  // main
  let main: string | undefined;
  if (cfg.main !== undefined) {
    if (!isStr(cfg.main) || cfg.main === "") err(ctx, `"main" should be a string, but got ${q(cfg.main)}`);
    else main = cfg.main.replace(/^\.\//, "");
  } else if (assets !== undefined) {
    main = ASSETS_ONLY_ENTRY;
    // As the legacy config does: a Worker with only assets reaches them through env.ASSETS.
    assets.binding ??= "ASSETS";
  } else err(ctx, 'a "main" entry point is required (or "assets" for a Worker with only static assets)');

  // vars
  let vars: Record<string, string> | undefined;
  if (cfg.vars !== undefined) {
    if (!isRec(cfg.vars)) err(ctx, `"vars" should be an object, but got ${q(cfg.vars)}`);
    else {
      vars = {};
      for (const [key, value] of Object.entries(cfg.vars)) {
        if (!BINDING_RE.test(key)) {
          err(ctx, `vars.${key}: the name must be a JavaScript identifier`);
          continue;
        }
        // SAFETY: the build bakes vars with JSON.stringify, so a number, boolean or object reaches the Worker as written.
        vars[key] = value as string;
      }
    }
  }

  // secrets
  let secrets: string[] | undefined;
  if (cfg.secrets !== undefined) {
    if (!isRec(cfg.secrets))
      err(ctx, `"secrets" should be an object with a "required" list, but got ${q(cfg.secrets)}`);
    else {
      if (cfg.secrets.required !== undefined) {
        if (!Array.isArray(cfg.secrets.required) || cfg.secrets.required.some((s) => !isStr(s) || !BINDING_RE.test(s)))
          err(ctx, `"secrets.required" should be an array of names, but got ${q(cfg.secrets.required)}`);
        else secrets = cfg.secrets.required.filter(isString);
      }
      for (const key of Object.keys(cfg.secrets))
        if (key !== "required") note(ctx, `secrets.${key}`, `unknown field "${key}" (ignored)`);
    }
  }

  // stores: the Cloudflare id is not a store name here yet, so it is not kept; every app's stores are private to it
  const idNotes: string[] = [];
  const stores = (
    field: "kv_namespaces" | "d1_databases" | "r2_buckets",
    idKey: string,
    extraKnown: readonly string[],
    noisy: Record<string, string>,
  ): ResourceRef[] | undefined => {
    if (cfg[field] === undefined) return undefined;
    const out: ResourceRef[] = [];
    for (const [index, entry] of list(ctx, field, cfg[field]).entries()) {
      const binding = bindingName(ctx, field, entry.binding);
      if (binding === undefined) continue;
      ignoredKeys(ctx, `${field}[${index}]`, entry, ["binding", idKey, ...extraKnown], noisy);
      if (isStr(entry[idKey]) && entry[idKey] !== "") idNotes.push(`${field}.${binding}`);
      if (field === "d1_databases" && isStr(entry.migrations_dir) && entry.migrations_dir !== "")
        extras.migrationsDirs[binding] = entry.migrations_dir;
      out.push(binding);
    }
    return out;
  };
  const kv_namespaces = stores("kv_namespaces", "id", ["preview_id", "remote"], {
    remote: "remote: true is not supported; the store is local to the Cloud app",
  });
  const d1_databases = stores(
    "d1_databases",
    "database_id",
    ["database_name", "preview_database_id", "migrations_dir", "migrations_table", "database_internal_env", "remote"],
    {
      migrations_pattern: "not supported (ignored)",
      jurisdiction: "not supported (ignored)",
      remote: "remote: true is not supported; the store is local to the Cloud app",
    },
  );
  const r2_buckets = stores("r2_buckets", "bucket_name", ["preview_bucket_name", "local_dev", "remote"], {
    jurisdiction: "not supported (ignored)",
    remote: "remote: true is not supported; the store is local to the Cloud app",
  });
  if (idNotes.length > 0)
    note(
      ctx,
      idNotes.join(", "),
      `${idNotes.length === 1 ? "has a Cloudflare id" : "have Cloudflare ids"}; on Sproutboat every app's storage is its own, named after the binding, so the id is ignored and the store starts empty`,
    );

  // queues
  let queues: Array<string | (QueueBinding & { consume?: boolean })> | undefined;
  if (cfg.queues !== undefined) {
    if (!isRec(cfg.queues))
      err(ctx, `"queues" should be an object with "producers" and "consumers", but got ${q(cfg.queues)}`);
    else {
      queues = [];
      const consumers = list(ctx, "queues.consumers", cfg.queues.consumers);
      const byQueue = new Map<string, Rec>();
      for (const consumer of consumers) {
        if (!isStr(consumer.queue) || !QUEUE_RE.test(consumer.queue))
          err(
            ctx,
            `"queues.consumers" entries need a "queue" name (lowercase letters, digits and "-"), but got ${q(consumer.queue)}`,
          );
        else byQueue.set(consumer.queue, consumer);
      }
      const used = new Set<string>();
      for (const producer of list(ctx, "queues.producers", cfg.queues.producers)) {
        const binding = bindingName(ctx, "queues.producers", producer.binding);
        if (binding === undefined) continue;
        const queueName = isStr(producer.queue) ? producer.queue : binding.toLowerCase();
        if (!QUEUE_RE.test(queueName)) {
          err(
            ctx,
            `queues.producers.${binding}: "queue" must be lowercase letters, digits and "-", but got ${q(queueName)}`,
          );
          continue;
        }
        if (used.has(queueName)) {
          err(ctx, `queues: two bindings name the queue "${queueName}"`);
          continue;
        }
        used.add(queueName);
        ignoredKeys(ctx, `queues.producers.${binding}`, producer, ["binding", "queue"], {
          delivery_delay: "not supported (ignored)",
          remote: "remote: true is not supported",
        });
        const entry: QueueBinding & { consume?: boolean } = { binding, queue: queueName };
        const consumer = byQueue.get(queueName);
        if (consumer === undefined) entry.consume = false;
        else applyConsumer(ctx, entry, consumer);
        queues.push(entry);
      }
      // A consumer with no producer binding in this file: the app still consumes that queue, and gets a binding named after it.
      for (const [queueName, consumer] of byQueue) {
        if (used.has(queueName)) continue;
        used.add(queueName);
        const entry: QueueBinding & { consume?: boolean } = {
          binding: queueName.replace(/-/g, "_").toUpperCase(),
          queue: queueName,
        };
        applyConsumer(ctx, entry, consumer);
        queues.push(entry);
      }
      for (const key of Object.keys(cfg.queues))
        if (key !== "producers" && key !== "consumers") note(ctx, `queues.${key}`, `unknown field "${key}" (ignored)`);
    }
  }

  // durable objects
  let durable_objects: Record<string, string> | undefined;
  if (cfg.durable_objects !== undefined) {
    if (!isRec(cfg.durable_objects))
      err(ctx, `"durable_objects" should be an object with "bindings", but got ${q(cfg.durable_objects)}`);
    else {
      durable_objects = {};
      for (const entry of list(ctx, "durable_objects.bindings", cfg.durable_objects.bindings)) {
        const binding = bindingName(ctx, "durable_objects.bindings", entry.name, "name");
        if (binding === undefined) continue;
        if (!isStr(entry.class_name) || !CLASS_RE.test(entry.class_name)) {
          err(
            ctx,
            `durable_objects.bindings "${binding}" needs a "class_name" that is a class identifier, but got ${q(entry.class_name)}`,
          );
          continue;
        }
        if (entry.script_name !== undefined)
          note(
            ctx,
            `durable_objects.bindings.${binding}.script_name`,
            "a class in another Worker is not supported; the class must be in this Worker",
          );
        if (entry.environment !== undefined)
          note(ctx, `durable_objects.bindings.${binding}.environment`, "not supported (ignored)");
        durable_objects[binding] = entry.class_name;
      }
      for (const key of Object.keys(cfg.durable_objects))
        if (key !== "bindings" && key !== "code_update_strategy")
          note(ctx, `durable_objects.${key}`, `unknown field "${key}" (ignored)`);
    }
  }
  if (cfg.migrations !== undefined) {
    if (!Array.isArray(cfg.migrations)) err(ctx, `"migrations" should be an array, but got ${q(cfg.migrations)}`);
    else
      for (const migration of cfg.migrations) {
        if (!isRec(migration)) {
          err(ctx, `"migrations" entries should be objects, but got ${q(migration)}`);
          continue;
        }
        for (const key of ["renamed_classes", "deleted_classes", "transferred_classes"])
          if (!isEmpty(migration[key]))
            note(
              ctx,
              `migrations.${key}`,
              "not supported; no data is moved (every class keeps its SQLite storage by name)",
            );
      }
  }

  // services
  let services: Array<{ binding: string; service: string }> | undefined;
  if (cfg.services !== undefined) {
    services = [];
    for (const [index, entry] of list(ctx, "services", cfg.services).entries()) {
      const binding = bindingName(ctx, "services", entry.binding);
      if (binding === undefined) continue;
      if (!isStr(entry.service) || !PROJECT_RE.test(entry.service)) {
        err(
          ctx,
          `services "${binding}" needs a "service" that names an app (3 to ${APP_NAME_MAX} characters: lowercase letters, digits, "-"), but got ${q(entry.service)}`,
        );
        continue;
      }
      ignoredKeys(ctx, `services[${index}]`, entry, ["binding", "service"], {
        entrypoint: "named entrypoints are not supported; the default export is called",
        props: "not supported (ignored)",
        environment: "not supported (ignored)",
        remote: "remote: true is not supported",
      });
      services.push({ binding, service: entry.service });
    }
  }

  // analytics engine
  let analytics_engine_datasets: string[] | undefined;
  if (cfg.analytics_engine_datasets !== undefined) {
    analytics_engine_datasets = [];
    for (const entry of list(ctx, "analytics_engine_datasets", cfg.analytics_engine_datasets)) {
      const binding = bindingName(ctx, "analytics_engine_datasets", entry.binding);
      if (binding !== undefined) analytics_engine_datasets.push(binding);
    }
  }

  // ratelimits
  let ratelimiters: SproutboatConfig["ratelimiters"];
  if (cfg.ratelimits !== undefined) {
    ratelimiters = [];
    for (const entry of list(ctx, "ratelimits", cfg.ratelimits)) {
      const binding = bindingName(ctx, "ratelimits", entry.name, "name");
      const simple = isRec(entry.simple) ? entry.simple : undefined;
      if (binding === undefined) continue;
      if (simple === undefined || !isNum(simple.limit) || !isNum(simple.period)) {
        err(ctx, `ratelimits "${binding}" needs "simple": { "limit": <n>, "period": <seconds> }`);
        continue;
      }
      ratelimiters.push({ binding, limit: simple.limit, period: simple.period });
    }
  }

  // triggers
  let triggers: { crons?: string[] } | undefined;
  if (cfg.triggers !== undefined) {
    if (!isRec(cfg.triggers)) err(ctx, `"triggers" should be an object, but got ${q(cfg.triggers)}`);
    else {
      triggers = {};
      if (cfg.triggers.crons !== undefined) {
        const crons = cfg.triggers.crons;
        if (!Array.isArray(crons) || crons.some((c) => !isStr(c) || c.trim().split(/\s+/).length !== 5))
          err(ctx, `"triggers.crons" should be an array of 5-field cron expressions, but got ${q(crons)}`);
        else triggers.crons = crons.filter(isString).map((c) => c.trim());
      }
    }
  }

  // version_metadata
  let version_metadata: string | undefined;
  if (cfg.version_metadata !== undefined) {
    if (!isRec(cfg.version_metadata))
      err(ctx, `"version_metadata" should be an object with a "binding", but got ${q(cfg.version_metadata)}`);
    else version_metadata = bindingName(ctx, "version_metadata", cfg.version_metadata.binding);
  }

  // workers_dev, limits, dev
  if (cfg.workers_dev !== undefined) {
    if (!isBoolean(cfg.workers_dev)) err(ctx, `"workers_dev" should be true or false, but got ${q(cfg.workers_dev)}`);
    else extras.workersDev = cfg.workers_dev;
  }
  if (cfg.limits !== undefined) {
    if (!isRec(cfg.limits)) err(ctx, `"limits" should be an object, but got ${q(cfg.limits)}`);
    else if (cfg.limits.cpu_ms !== undefined) {
      if (
        !isNum(cfg.limits.cpu_ms) ||
        !Number.isInteger(cfg.limits.cpu_ms) ||
        cfg.limits.cpu_ms < 10 ||
        cfg.limits.cpu_ms > 600_000
      )
        err(ctx, `"limits.cpu_ms" should be an integer from 10 to 600000 here, but got ${q(cfg.limits.cpu_ms)}`);
      else extras.cpuMs = cfg.limits.cpu_ms;
    }
  }
  if (isRec(cfg.dev)) {
    const dev: NonNullable<WranglerExtras["dev"]> = {};
    if (isNum(cfg.dev.port)) dev.port = cfg.dev.port;
    if (isStr(cfg.dev.ip)) dev.ip = cfg.dev.ip;
    if (dev.port !== undefined || dev.ip !== undefined) extras.dev = dev;
  }
  if (cfg.$schema !== undefined && !isStr(cfg.$schema))
    err(ctx, `"$schema" should be a string, but got ${q(cfg.$schema)}`);

  // Names must be unique once lowercased (the Cloud lowercases resource ids), and no two slots may share one.
  const refName = (ref: string | { binding: string }) => (isStr(ref) ? ref : ref.binding);
  const slots = [
    ...Object.keys(vars ?? {}),
    ...(secrets ?? []),
    ...(kv_namespaces ?? []).map(refName),
    ...(d1_databases ?? []).map(refName),
    ...(r2_buckets ?? []).map(refName),
    ...(queues ?? []).map(refName),
    ...(analytics_engine_datasets ?? []),
    ...Object.keys(durable_objects ?? {}),
    ...(services ?? []).map((s) => s.binding),
    ...(ratelimiters ?? []).map((r) => r.binding),
    ...(assets?.binding ? [assets.binding] : []),
    ...(version_metadata ? [version_metadata] : []),
  ];
  const seen = new Set<string>();
  for (const slot of slots) {
    if (seen.has(slot))
      err(ctx, `the binding name ${q(slot)} is used twice (names must be unique across vars, secrets and bindings)`);
    seen.add(slot);
  }
  const lowered = new Map<string, string>();
  for (const store of [...(kv_namespaces ?? []), ...(d1_databases ?? []), ...(r2_buckets ?? [])].map(refName)) {
    const key = store.toLowerCase();
    const other = lowered.get(key);
    if (other !== undefined && other !== store)
      err(
        ctx,
        `the bindings ${q(other)} and ${q(store)} differ only in case; the Cloud names a store by its lowercased binding, so use one spelling`,
      );
    lowered.set(key, store);
  }

  if (ctx.errors.length > 0 || name === undefined || main === undefined || compatibility_date === undefined)
    return { ok: false, errors: ctx.errors.length > 0 ? ctx.errors : [`${file}: could not be read`] };

  const value: SproutboatConfig = { name, main, compatibility_date };
  if (isString(cfg.$schema)) value.$schema = cfg.$schema;
  if (vars !== undefined) value.vars = vars;
  if (kv_namespaces !== undefined) value.kv_namespaces = kv_namespaces;
  if (secrets !== undefined) value.secrets = secrets;
  if (d1_databases !== undefined) value.d1_databases = d1_databases;
  if (r2_buckets !== undefined) value.r2_buckets = r2_buckets;
  if (queues !== undefined) value.queues = queues;
  if (analytics_engine_datasets !== undefined) value.analytics_engine_datasets = analytics_engine_datasets;
  if (durable_objects !== undefined) value.durable_objects = durable_objects;
  if (services !== undefined) value.services = services;
  if (triggers !== undefined) value.triggers = triggers;
  if (ratelimiters !== undefined) value.ratelimiters = ratelimiters;
  if (assets !== undefined) value.assets = assets;
  if (version_metadata !== undefined) value.version_metadata = version_metadata;
  return { ok: true, value, warnings: [...ctx.warnings], extras };
}

function applyConsumer(ctx: Ctx, entry: QueueBinding, consumer: Rec): void {
  const ranges = [
    ["max_batch_size", "max_batch_size", 1, 100, true],
    ["max_batch_timeout", "max_batch_timeout", 0, 60, false],
    ["max_retries", "max_retries", 0, 100, true],
    ["retry_delay", "retry_delay", 0, 86400, true],
  ] as const;
  for (const [key, field, min, max, integer] of ranges) {
    const item = consumer[key];
    if (item === undefined) continue;
    if (isNum(item) && item >= min && item <= max && (!integer || Number.isInteger(item))) entry[field] = item;
    else
      err(
        ctx,
        `queues.consumers "${consumer.queue}": "${key}" must be ${integer ? "an integer" : "a number"} from ${min} to ${max}, but got ${q(item)}`,
      );
  }
  if (consumer.dead_letter_queue !== undefined) {
    if (
      isStr(consumer.dead_letter_queue) &&
      QUEUE_RE.test(consumer.dead_letter_queue) &&
      consumer.dead_letter_queue !== entry.queue
    )
      entry.dead_letter_queue = consumer.dead_letter_queue;
    else err(ctx, `queues.consumers "${consumer.queue}": "dead_letter_queue" must be another queue's name`);
  }
  for (const key of Object.keys(consumer))
    if (
      ![
        "queue",
        "type",
        "max_batch_size",
        "max_batch_timeout",
        "max_retries",
        "retry_delay",
        "dead_letter_queue",
        "max_concurrency",
        "visibility_timeout_ms",
      ].includes(key)
    )
      note(ctx, `queues.consumers.${consumer.queue}.${key}`, `unknown field "${key}" (ignored)`);
}

/** Parse the text of a Wrangler file and convert it. */
export function parseWranglerConfig(text: string, kind: WranglerKind, options: WranglerOptions = {}): WranglerLoad {
  const file = options.file ?? "wrangler.jsonc";
  const parsed = parseWranglerSource(text, kind);
  if (!parsed.ok) return { ok: false, errors: [`${file}: ${parsed.error}`] };
  return convertWrangler(parsed.raw, options);
}
