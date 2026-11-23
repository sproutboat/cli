/**
 * The `sproutboat types` command, with Wrangler's contract (`wrangler types [path]`). Two differences are on purpose:
 * `--include-runtime` references the runtime types shipped with the CLI instead of copying them in, and there is no
 * `--include-main-module`. A positional that is an existing directory is still read as a project directory (earlier releases).
 */
import { existsSync, statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { SproutboatConfig } from "./config";
import {
  exportedClasses,
  generateTypes,
  hashOf,
  isCurrent,
  LEGACY_TYPES_FILE,
  LEGACY_TYPES_HEADER,
  TYPES_FILE,
  type TypesOptions,
} from "./types-gen";

export const TYPES_USAGE =
  "types [path] [--env-interface <name>] [--no-strict-vars] [--no-include-runtime] [--no-include-env] [--check]";

export type TypesArgs = {
  positional?: string;
  options: Omit<TypesOptions, "command" | "mainModule">;
  check: boolean;
};

type BooleanOption = "strictVars" | "includeRuntime" | "includeEnv";
const BOOLEAN_FLAGS = new Map<string, BooleanOption>([
  ["--strict-vars", "strictVars"],
  ["--include-runtime", "includeRuntime"],
  ["--include-env", "includeEnv"],
]);

export function parseTypesArgs(args: readonly string[]): TypesArgs | { error: string } {
  const out: TypesArgs = { options: {}, check: false };
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at]!;
    if (arg === "--check") out.check = true;
    else if (arg === "--env-interface") {
      const value = args[(at += 1)];
      if (value === undefined || value.startsWith("--")) return { error: "--env-interface needs a name" };
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) return { error: `"${value}" is not a valid interface name` };
      out.options.envInterface = value;
    } else if (BOOLEAN_FLAGS.has(arg) || (arg.startsWith("--no-") && BOOLEAN_FLAGS.has(`--${arg.slice(5)}`))) {
      const negated = !BOOLEAN_FLAGS.has(arg);
      const key = BOOLEAN_FLAGS.get(negated ? `--${arg.slice(5)}` : arg)!;
      if (negated) {
        out.options[key] = false;
        continue;
      }
      const next = args[at + 1];
      // `--strict-vars=false` arrives as `--strict-vars false`; a bare `--strict-vars` means true.
      if (next === "true" || next === "false") {
        out.options[key] = next === "true";
        at += 1;
      } else if (next === undefined || next.startsWith("--")) out.options[key] = true;
      else return { error: `${arg} takes true or false, not "${next}"` };
    } else if (arg.startsWith("-")) return { error: `unknown option ${arg}` };
    else if (out.positional === undefined) out.positional = arg;
    else return { error: `unexpected argument "${arg}"` };
  }
  return out;
}

function commandLine(parsed: TypesArgs, path: string | undefined): string {
  const { envInterface, strictVars, includeRuntime, includeEnv } = parsed.options;
  return [
    "sproutboat types",
    ...(path ? [path] : []),
    ...(envInterface && envInterface !== "Env" ? [`--env-interface=${envInterface}`] : []),
    ...(strictVars === false ? ["--strict-vars=false"] : []),
    ...(includeRuntime === false ? ["--include-runtime=false"] : []),
    ...(includeEnv === false ? ["--include-env=false"] : []),
  ].join(" ");
}

export type TypesPlan = {
  path: string;
  text: string;
  legacyDirectory: boolean;
};

export async function planTypes(
  parsed: TypesArgs,
  config: SproutboatConfig,
  projectDirectory: string,
  cwd: string = process.cwd(),
): Promise<TypesPlan> {
  const positional = parsed.positional;
  const asDirectory = positional !== undefined && isDirectory(resolve(cwd, positional));
  const path =
    positional === undefined || asDirectory ? resolve(projectDirectory, TYPES_FILE) : resolve(cwd, positional);

  let mainModule: TypesOptions["mainModule"];
  if (/\.(?:ts|mts|tsx)$/.test(config.main)) {
    const entry = resolve(projectDirectory, config.main);
    try {
      const classes = exportedClasses(await readFile(entry, "utf8"));
      if (classes.length) {
        const rel = relative(dirname(path), entry.replace(/\.[^./\\]+$/, ""))
          .split(sep)
          .join("/");
        mainModule = { importPath: rel.startsWith(".") ? rel : `./${rel}`, classes };
      }
    } catch {
      // No entry file yet: the bindings are still worth typing.
    }
  }
  const text = generateTypes(config, {
    ...parsed.options,
    mainModule,
    command: commandLine(parsed, positional !== undefined && !asDirectory ? positional : undefined),
  });
  return { path, text, legacyDirectory: asDirectory };
}

export async function checkTypes(plan: TypesPlan): Promise<"current" | "stale" | "missing"> {
  if (!existsSync(plan.path)) return "missing";
  return isCurrent(await readFile(plan.path, "utf8"), plan.text) ? "current" : "stale";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function removeLegacyTypes(projectDir: string): Promise<boolean> {
  const legacy = resolve(projectDir, LEGACY_TYPES_FILE);
  try {
    if (!(await readFile(legacy, "utf8")).startsWith(LEGACY_TYPES_HEADER)) return false;
    await rm(legacy);
    return true;
  } catch {
    return false;
  }
}

/** Rewrite the generated types when the config has moved on, and only when the default file is the one a plain
 * `sproutboat types` wrote. Writes only when the content differs, so it stays out of the way of git and file watchers;
 * a file made with other flags or by hand is left alone, as Wrangler leaves it. */
export async function refreshTypes(
  projectDir: string,
  config: SproutboatConfig,
): Promise<{ wrote: boolean; removedLegacy: boolean }> {
  const parsed = parseTypesArgs([]);
  if ("error" in parsed) return { wrote: false, removedLegacy: false };
  const plan = await planTypes(parsed, config, projectDir, projectDir);
  let have: string | undefined;
  try {
    have = await readFile(plan.path, "utf8");
  } catch {
    // No file yet: only write one if the project already opted in with a tsconfig. A plain JavaScript project gets none.
    if (!existsSync(resolve(projectDir, "tsconfig.json"))) return { wrote: false, removedLegacy: false };
  }
  if (have !== undefined) {
    const customCommand = !(have.split("\n", 2)[1] ?? "").includes("`sproutboat types`");
    if (hashOf(have) === undefined || customCommand || hashOf(have) === hashOf(plan.text))
      return { wrote: false, removedLegacy: false };
  }
  await writeFile(plan.path, plan.text);
  return { wrote: true, removedLegacy: await removeLegacyTypes(projectDir) };
}
