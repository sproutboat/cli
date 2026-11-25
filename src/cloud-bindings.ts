/**
 * `sproutboat.jsonc` bindings as the Cloud's app record carries them (sproutboat-cloud `src/record.ts`), checked here so a
 * mistake fails before anything is uploaded. Each app's storage is private to it, so a resource id is the binding name in
 * lowercase (`d1_databases: ["DB"]` is `d1/DB`); a queue gets its queue name. The host creates the storage on first use.
 */
import { existsSync, readFileSync } from "node:fs";
import { isString } from "./json";
import { resolve } from "node:path";
import { queueSettings, resourceRefs, type SproutboatConfig } from "./config";
import { CloudError } from "./cloud";

export type RecordBinding = {
  name: string;
  kind: "kv" | "d1" | "r2" | "queue" | "do" | "ae" | "ratelimit" | "assets" | "secret";
  resource_id: string | null;
  config: Record<string, string | number>;
};
export type RecordQueueConsumer = {
  queue: string;
  max_batch_size: number;
  max_batch_timeout_ms: number;
  max_retries: number;
  dead_letter_queue: string | null;
};
export type CloudBindings = {
  bindings: RecordBinding[];
  crons: string[];
  queue_consumers: RecordQueueConsumer[];
  warnings: string[];
};

export const MAX_BINDINGS = 64;
export const MAX_CRONS = 16;
export const MAX_QUEUE_CONSUMERS = 16;
const RESOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CRON_CHARS_RE = /^[0-9A-Za-z*,/ -]+$/;

/** Cloudflare's defaults for a queue consumer, which the runtime applies when sproutboat.jsonc leaves a setting out. */
const QUEUE_DEFAULTS = { maxBatchSize: 10, maxBatchTimeout: 0, maxRetries: 3 };

function resourceIdFor(what: string, name: string): string {
  const id = name.toLowerCase();
  if (!RESOURCE_ID_RE.test(id))
    throw new CloudError(
      `${what} "${name}" cannot be a Cloud resource name: lowercased it must be 1 to 64 characters, start with a letter or digit, and use only letters, digits, "_" and "-"`,
    );
  return id;
}

/** A cron as the Cloud stores it: single spaces, five fields, at most 128 characters of the allowed set. */
function normalizeCron(expression: string): string {
  const cron = expression.trim().split(/\s+/).join(" ");
  if (cron.length > 128 || !CRON_CHARS_RE.test(cron) || cron.split(" ").length !== 5)
    throw new CloudError(
      `triggers.crons: "${expression}" is not a cron the Cloud accepts (5 fields of digits, letters and * , / -, at most 128 characters)`,
    );
  return cron;
}

type Mappable = Pick<
  SproutboatConfig,
  | "kv_namespaces"
  | "d1_databases"
  | "r2_buckets"
  | "queues"
  | "analytics_engine_datasets"
  | "durable_objects"
  | "ratelimiters"
  | "secrets"
  | "assets"
  | "triggers"
>;

/** Every binding kind as a record entry, plus `crons` and one `queue_consumers` entry per queue. `serviceBindings` counts
 * toward the 64-binding limit. Throws CloudError for anything the Cloud would refuse. */
export function mapCloudBindings(config: Mappable, serviceBindings = 0): CloudBindings {
  const bindings: RecordBinding[] = [];
  const warnings: string[] = [];
  const pinned: string[] = [];

  for (const [kind, field] of [
    ["kv", "kv_namespaces"],
    ["d1", "d1_databases"],
    ["r2", "r2_buckets"],
  ] as const)
    for (const ref of resourceRefs(config[field])) {
      if (ref.id !== undefined) pinned.push(`${field}.${ref.binding}`);
      bindings.push({
        name: ref.binding,
        kind,
        resource_id: resourceIdFor(`${field} binding`, ref.binding),
        config: {},
      });
    }

  const queue_consumers: RecordQueueConsumer[] = [];
  const queueNames = new Set<string>();
  // A Wrangler file consumes only the queues it lists under queues.consumers; the legacy dialect consumes every bound queue.
  const notConsumed = new Set(
    (config.queues ?? []).flatMap((entry) =>
      isString(entry) ? [] : "consume" in entry && entry.consume === false ? [entry.binding] : [],
    ),
  );
  for (const queue of queueSettings(config.queues)) {
    const resource = resourceIdFor("queue", queue.queue);
    if (queueNames.has(resource))
      throw new CloudError(
        `queues: two bindings name the queue "${resource}" (queue names are lowercase on the Cloud)`,
      );
    queueNames.add(resource);
    const settings: RecordBinding["config"] = { queue: queue.queue };
    if (queue.retryDelay !== undefined) settings.retry_delay = queue.retryDelay;
    bindings.push({ name: queue.binding, kind: "queue", resource_id: resource, config: settings });
    if (notConsumed.has(queue.binding)) continue;
    queue_consumers.push({
      queue: resource,
      max_batch_size: queue.maxBatchSize ?? QUEUE_DEFAULTS.maxBatchSize,
      max_batch_timeout_ms: Math.round((queue.maxBatchTimeout ?? QUEUE_DEFAULTS.maxBatchTimeout) * 1000),
      max_retries: queue.maxRetries ?? QUEUE_DEFAULTS.maxRetries,
      dead_letter_queue:
        queue.deadLetterQueue === undefined ? null : resourceIdFor("dead_letter_queue", queue.deadLetterQueue),
    });
  }
  for (const ref of resourceRefs(config.queues)) if (ref.id !== undefined) pinned.push(`queues.${ref.binding}`);

  for (const name of config.analytics_engine_datasets ?? [])
    bindings.push({ name, kind: "ae", resource_id: null, config: {} });
  for (const [name, className] of Object.entries(config.durable_objects ?? {}))
    bindings.push({ name, kind: "do", resource_id: null, config: { class_name: className } });
  for (const limiter of config.ratelimiters ?? [])
    bindings.push({
      name: limiter.binding,
      kind: "ratelimit",
      resource_id: null,
      config: { limit: limiter.limit, period: limiter.period },
    });
  if (config.assets?.binding)
    bindings.push({ name: config.assets.binding, kind: "assets", resource_id: null, config: {} });
  for (const name of config.secrets ?? []) bindings.push({ name, kind: "secret", resource_id: null, config: {} });

  if (bindings.length + serviceBindings > MAX_BINDINGS)
    throw new CloudError(
      `the config declares ${bindings.length + serviceBindings} bindings (secrets, services and assets count); the Cloud takes at most ${MAX_BINDINGS} per app`,
    );
  if (queue_consumers.length > MAX_QUEUE_CONSUMERS)
    throw new CloudError(
      `the config binds ${queue_consumers.length} queues, and each one is consumed by the app; the Cloud takes at most ${MAX_QUEUE_CONSUMERS} queue consumers per app`,
    );
  const crons = (config.triggers?.crons ?? []).map(normalizeCron);
  if (crons.length > MAX_CRONS)
    throw new CloudError(`triggers.crons lists ${crons.length} crons; the Cloud takes at most ${MAX_CRONS} per app`);

  if (pinned.length > 0)
    warnings.push(
      `${pinned.join(", ")} pin${pinned.length === 1 ? "s" : ""} an account-level id; on the Cloud each app's storage is private to it, so the id is ignored and the app gets its own`,
    );
  return { bindings, crons, queue_consumers, warnings };
}

function exportedNames(source: string): Set<string> | null {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  if (/\bexport\s*\*\s*(?!as\b)from\b/.test(code)) return null;
  const names = new Set<string>();
  for (const m of code.matchAll(
    /\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  ))
    names.add(m[1]!);
  for (const m of code.matchAll(/\bexport\s*(?:type\s*)?\{([^}]*)\}/g))
    for (const part of m[1]!.split(",")) {
      const exported = part
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (exported) names.add(exported);
    }
  for (const m of code.matchAll(/\bexport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\b/g)) names.add(m[1]!);
  return names;
}

/**
 * Every class named in `durable_objects` must be exported by the entry module, or the app starts and then fails at the
 * first Durable Object call. Checked from the source text: a source with an `export *` cannot be judged and passes, and so
 * does an entry the CLI cannot read (the build reports that itself).
 */
export function checkDurableObjectExports(config: Mappable & Pick<SproutboatConfig, "main">, directory: string): void {
  const classes = Object.entries(config.durable_objects ?? {});
  if (classes.length === 0) return;
  const entry = resolve(directory, config.main);
  if (!existsSync(entry)) return;
  const exported = exportedNames(readFileSync(entry, "utf8"));
  if (exported === null) return;
  for (const [binding, className] of classes)
    if (!exported.has(className))
      throw new CloudError(
        `durable_objects ${binding} names the class "${className}", which ${config.main} does not export; add \`export class ${className}\` (or re-export it) so the Cloud can run it`,
      );
}

export function describeCloudBindings(plan: CloudBindings): string[] {
  const lines: string[] = [];
  for (const b of plan.bindings) {
    const target =
      b.kind === "do"
        ? `class ${String(b.config.class_name)}`
        : b.kind === "ratelimit"
          ? `${String(b.config.limit)} per ${String(b.config.period)} s`
          : b.resource_id !== null
            ? `-> ${b.resource_id}`
            : "";
    lines.push(`${b.kind.padEnd(9)} ${b.name}${target ? `  ${target}` : ""}`);
  }
  for (const c of plan.queue_consumers)
    lines.push(
      `consumer  ${c.queue}  batch ${c.max_batch_size} / ${c.max_batch_timeout_ms} ms, ${c.max_retries} retries${c.dead_letter_queue ? `, dead letters to ${c.dead_letter_queue}` : ""}`,
    );
  for (const cron of plan.crons) lines.push(`cron      ${cron}`);
  return lines;
}
