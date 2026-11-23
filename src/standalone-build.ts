/**
 * #15: `sproutboat build --standalone`. One executable with the compiled sprout, its assets and binding declarations and
 * SQLite linked in. `buildArtifact` with the embedded transport already produces that binary, so this copies it out.
 */
import { existsSync, readFileSync } from "node:fs";
import { chmod, cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { readAssetRules, walkAssets } from "./assets";
import { buildArtifact, emitGenerated, type BuildInput } from "./build";
import { ASSETS_STORE_MIN_DATE } from "./cloud-deploy";
import type { Bindings } from "./wrap";

export type StandaloneBuildInput = BuildInput & {
  outPath?: string;
  /** The release build (`-flto -O3`). Off by default: units still compile at -O3 but the link skips LTO, 1.5 to 2x faster
   * cold and ~90 MB instead of 1.1 to 1.6 GB, at some request throughput (docs/standalone.md). */
  release?: boolean;
};

export function isReleaseBuild(args: string[], env: Record<string, string | undefined> = process.env): boolean {
  if (args.includes("--release")) return true;
  const value = env.SPROUTBOAT_RELEASE;
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

export type StandaloneBuildResult = { outPath: string; bytes: number };

/** Bindings a standalone binary cannot serve. A build error, not a runtime no-op: a binding that silently does nothing is
 * discovered in production, on a device someone has to reach physically. */
export function unsupportedBindings(bindings: Pick<Partial<Bindings>, "services">): string[] {
  const reasons: string[] = [];
  if ((bindings.services ?? []).length > 0) {
    reasons.push("service bindings call another deployment through an edge, which a standalone binary has none of");
  }
  return reasons;
}

function assertStandaloneSupported(input: BuildInput): void {
  const blocked = unsupportedBindings(input.config);
  if (blocked.length > 0) {
    throw new Error(`cannot build a standalone binary for this project:\n  - ${blocked.join("\n  - ")}`);
  }
}

/**
 * Whether the worker of a Cloud deploy reads its own assets, so the module would have to carry them: Cloudflare gives it
 * `env.<BINDING>` only when `assets.binding` is set, and runs it before the files only for `run_worker_first` (here
 * `run_sprout_first`). Otherwise the edge serves the files alone. Whether they FIT is `planAssetBake`'s question.
 */
export function workerReadsAssets(assets: BuildInput["config"]["assets"]): boolean {
  if (!assets) return false;
  const first = assets.run_sprout_first;
  return Boolean(assets.binding) || first === true || (Array.isArray(first) && first.length > 0);
}

/** The patched Porffor linker throws `static data exceeds module ABI region` when ONE module's static data (every string
 * literal: prelude, the worker's strings, baked files and manifest) reaches this many bytes (toolchain a21 patch). */
export const MODULE_STATIC_LIMIT = 1_048_576;
/** Kept free below the limit so a prelude that grows, or an estimate that is a little low, never turns into a failed deploy. */
export const MODULE_STATIC_MARGIN = 65_536;
/** Static data of a module with no assets and no strings of its own: measured at 126,080 bytes with runtime 0.47, rounded up. */
export const MODULE_STATIC_BASE = 131_072;
/** Static data one baked file costs besides its bytes: measured at 102 to 125 bytes per file (1,000 and 3,000 files, keys of
 * about 40 characters). Used as key length + this, which stays above the measured cost. */
const STATIC_PER_FILE = 88;

export type AssetBakePlan = {
  reads: boolean;
  bake: boolean;
  files: number;
  fileBytes: number;
  bakedBytes: number;
  budget: number;
  overBy: number;
  store: boolean;
};

/**
 * Bake the assets into a Cloud emit only when the worker reads them AND they fit. Bytes are measured as static data: a baked
 * file is a latin1 string (one byte per byte), plus its key and manifest entry, plus the worker's own strings in full (an
 * upper bound). Files that do not fit stay out and the edge still serves them; from ASSETS_STORE_MIN_DATE the worker reads them too.
 */
export function planAssetBake(input: BuildInput): AssetBakePlan {
  const assets = input.config.assets;
  const reads = workerReadsAssets(assets);
  // A date is ISO, so the string order is the date order (as in checkServiceBindings and types-gen); a config without one compares false: old.
  const store = input.config.compatibility_date >= ASSETS_STORE_MIN_DATE;
  const empty = { reads, bake: reads, files: 0, fileBytes: 0, bakedBytes: 0, budget: 0, overBy: 0, store };
  if (!assets || !reads) return { ...empty, bake: false };
  const dir = resolve(input.projectDir, assets.directory);
  // A missing directory is the build's own error, raised with its message right after.
  if (!existsSync(dir)) return empty;
  const files = walkAssets(dir);
  let fileBytes = 0;
  let bakedBytes = 0;
  for (const [key, entry] of Object.entries(files)) {
    fileBytes += entry.size;
    bakedBytes += entry.size + Buffer.byteLength(key, "utf8") + STATIC_PER_FILE;
  }
  const rules = readAssetRules(dir);
  bakedBytes += JSON.stringify([rules.headers, rules.redirects]).length;
  // the build reads the worker from sourcePath when no source is given (build.ts), so count that file
  // bytes, not UTF-16 units: a non-ASCII string takes at least as many bytes in static data as it has characters, and UTF-8 is the upper bound
  const own =
    Buffer.byteLength(input.source ?? readFileSync(input.sourcePath, "utf8"), "utf8") +
    Buffer.byteLength(JSON.stringify(input.config.vars ?? {}), "utf8");
  const budget = Math.max(0, MODULE_STATIC_LIMIT - MODULE_STATIC_MARGIN - MODULE_STATIC_BASE - own);
  const overBy = Math.max(0, bakedBytes - budget);
  return { reads, bake: overBy === 0, files: Object.keys(files).length, fileBytes, bakedBytes, budget, overBy, store };
}

export function describeAssetBake(plan: AssetBakePlan): string {
  const bytes = (n: number) => n.toLocaleString("en-US");
  if (!plan.reads) return "served by the edge, none in the module (the worker does not read env.ASSETS)";
  if (plan.bake)
    return `served by the edge, and kept in the module (the worker reads env.ASSETS; fits: ${bytes(plan.bakedBytes)} of ${bytes(plan.budget)} bytes)`;
  const tooBig = `the files are too big to bake: ${bytes(plan.overBy)} bytes over the limit of ${bytes(plan.budget)}`;
  if (plan.store)
    return `served by the edge, none in the module (the worker reads env.ASSETS but ${tooBig}; it reads them from the Cloud's asset store, compatibility_date ${ASSETS_STORE_MIN_DATE} or later)`;
  return `served by the edge, none in the module (the worker reads env.ASSETS but ${tooBig}; set compatibility_date ${ASSETS_STORE_MIN_DATE} or later and it reads them from the Cloud's asset store)`;
}

/** The warning for a worker that reads assets that do not fit, or undefined (none from ASSETS_STORE_MIN_DATE on). */
export function assetBakeWarning(plan: AssetBakePlan): string | undefined {
  if (!plan.reads || plan.bake || plan.store) return undefined;
  return (
    `the assets (${plan.files} files, ${plan.fileBytes.toLocaleString("en-US")} bytes) do not fit in the module: ` +
    `${plan.overBy.toLocaleString("en-US")} bytes over the limit. env.ASSETS.fetch inside the worker will not find these files on the Cloud ` +
    `until the runtime reads the asset store; requests the edge serves from it still work. Set compatibility_date ${ASSETS_STORE_MIN_DATE} or later to have the worker read them from the Cloud's asset store`
  );
}

/** `build --standalone --emit-only`: byte for byte what a full standalone build compiles, at the same path, with every
 * check; nothing native is acquired or compiled. */
export async function emitStandalone(
  input: BuildInput,
  /** The Cloud compiles this unit and its hosts supply service bindings, so a deploy to the Cloud keeps them. */
  options: { forCloud?: boolean } = {},
): Promise<{ generatedPath: string; assetBake?: AssetBakePlan }> {
  if (!options.forCloud) assertStandaloneSupported(input);
  // A Cloud deploy sends the assets as a manifest the edge serves: baking them in breaks the compile past about 1 MiB. A worker
  // that reads its assets keeps them in the module only when they fit (as in 0.57.0); past that they stay out (0.58.0) and
  // the plan says so.
  const assetBake = options.forCloud === true ? planAssetBake(input) : undefined;
  const bakeAssets = assetBake === undefined || assetBake.bake;
  const { generatedPath } = await emitGenerated({ ...input, transport: "embedded", bakeAssets });
  return { generatedPath, assetBake };
}

export async function buildStandalone(input: StandaloneBuildInput): Promise<StandaloneBuildResult> {
  assertStandaloneSupported(input);
  const { release, ...rest } = input;
  const artifact = await buildArtifact({ ...rest, transport: "embedded", lto: release === true });

  const outPath = input.outPath ?? resolve(input.projectDir, "dist", input.config.name);
  await mkdir(resolve(outPath, ".."), { recursive: true });
  await cp(resolve(artifact.artifactDir, "sprout"), outPath);
  await chmod(outPath, 0o755);
  return { outPath, bytes: Bun.file(outPath).size };
}
