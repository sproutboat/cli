/**
 * #89 — bundle the handler before Porffor sees it.
 *
 * Porffor supports ESM imports. We still bundle first so capability
 * validation sees every dependency and the runtime wrapper receives one
 * controlled default export.
 *
 * Bun's bundler resolves relative imports across the project and bare
 * specifiers out of the project's own `node_modules`, then emits a single ESM
 * module. The capability bans (`process`, `Bun`, `node:`, WebSocket, …) are
 * checked against that output rather than the entry file, so a dependency
 * reaching for a Node API fails exactly as user code would.
 */
import { relative } from "node:path";
import { SOCKETS_DATE } from "@sproutboat/runtime";
import { NODE_SHIMS, SOCKET_NODE_SHIMS } from "./node-shims";

export type BundleResult = {
  /** One self-contained ESM module: what gets validated, hashed, and compiled. */
  code: string;
};

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

const entryLabel = (entryPath: string, projectDir: string): string => relative(projectDir, entryPath) || entryPath;

const shimSpecifiers = new RegExp(
  `^(${Object.keys(NODE_SHIMS)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})$`,
);

/**
 * Bun already bundles working polyfills for most node:* built-ins under
 * `target: "browser"` (verified for node:url, node:querystring). This
 * plugin only overrides the ones in NODE_SHIMS — currently just node:path,
 * whose bundled resolve() otherwise falls back to `process.cwd()`.
 */
const nodeShimsPlugin: import("bun").BunPlugin = {
  name: "sproutboat-node-shims",
  setup(build) {
    build.onResolve({ filter: shimSpecifiers }, (args) => ({ path: args.path, namespace: "sb-node-shim" }));
    build.onLoad({ filter: /.*/, namespace: "sb-node-shim" }, (args) => ({
      // SAFETY: onResolve above only ever routes a specifier matched by
      // shimSpecifiers (built from NODE_SHIMS's own keys) into this
      // namespace, so args.path is always one of NODE_SHIMS's keys here.
      contents: (NODE_SHIMS as Record<string, string>)[args.path],
      loader: "js",
    }));
  },
};

/**
 * Porffor lists the global builtin functions on the global object of every unit, and a function
 * named like one of them (postgres: `export const escapeIdentifier = function escape(str) {}`)
 * drops the entry from that unit alone, so a sproutd app that does it no longer matches the
 * runtime's common code and is rejected at admission. A named function expression's name is only
 * visible inside itself, so renaming it is safe unless the body calls itself by that name.
 */
const SHADOWED_BUILTIN_FUNCTIONS =
  /([=(:,?&|]\s*|\breturn\s+)function\s+(escape|unescape|eval|isNaN|isFinite|parseInt|parseFloat|encodeURI|encodeURIComponent|decodeURI|decodeURIComponent)\s*\(/g;

/** What a driver reads off `process`: an empty environment and a microtask for nextTick. */
/**
 * From PROCESS_GLOBAL_DATE `process.env` holds the app's text bindings, as it does in Workers with `nodejs_compat` from
 * `nodejs_compat_populate_process_env` (implied at compatibility date 2025-04-01): the string `vars` and the secrets, not
 * KV, D1 or other bindings. The wrapper sets `globalThis.env` (with `vars` baked in and each secret a lazy accessor)
 * before the handler's code runs, which is when this stub does, so it only mirrors them: a secret stays lazy, its value
 * is fetched on first read exactly as `env.NAME` would, and a secret that is not set reads `undefined`.
 */
const POPULATE_PROCESS_ENV = `
const source = globalThis.env;
if (source !== undefined && source !== null) {
  const names = Object.getOwnPropertyNames(source);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (descriptor !== undefined && descriptor.get !== undefined) {
      Object.defineProperty(env, name, {
        enumerable: true,
        configurable: true,
        get() { try { const value = source[name]; return typeof value === "string" ? value : undefined; } catch (e) { return undefined; } },
        set(value) { Object.defineProperty(env, name, { value, writable: true, enumerable: true, configurable: true }); },
      });
    } else if (typeof source[name] === "string") {
      env[name] = source[name];
    }
  }
}`;

const processStub = (populateEnv: boolean) => `
const env = {};
${populateEnv ? POPULATE_PROCESS_ENV : ""}
function nextTick(fn, ...args) { Promise.resolve().then(() => fn(...args)); }
const process = { env, platform: "linux", arch: "wasm32", version: "v20.0.0", versions: {}, argv: [], browser: true, nextTick, emitWarning() {}, cwd() { return "/"; }, stderr: { write() {} }, stdout: { write() {} }, on() {}, off() {}, once() {}, emit() {} };
export default process;
`;

/**
 * From this compatibility date the handler's own code gets `process` and `Buffer` like its dependencies do, and
 * `process.env` holds its string `vars` and secrets. Workers has the same behaviour under `nodejs_compat`: a global
 * `process` and, from `nodejs_compat_populate_process_env` (implied at 2025-04-01), `process.env` filled from the text
 * bindings. Sproutboat has no `nodejs_compat` flag, so a compatibility date is the gate. Later than SOCKETS_DATE, which
 * is when the source check stopped rejecting `process.x`.
 */
export const PROCESS_GLOBAL_DATE = "2026-11-23";

const DEPENDENCY_FILES = /node_modules\/.*\.(?:c?js|mjs)$/;
const APP_AND_DEPENDENCY_FILES = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const loaderOf = (file: string): "js" | "jsx" | "ts" | "tsx" =>
  /\.tsx$/.test(file) ? "tsx" : /\.[cm]?ts$/.test(file) ? "ts" : /\.jsx$/.test(file) ? "jsx" : "js";

/**
 * Node libraries use `Buffer` and `process` as free globals. Bun's browser target does not
 * inject them for a CommonJS file, so a dependency that never imports Buffer would throw a
 * ReferenceError at runtime. This gives every dependency file that uses one a local binding to the
 * bundled implementation (the `buffer` package, which Porffor compiles; see the toolchain notes on
 * typed array method dispatch). Before PROCESS_GLOBAL_DATE this is applied only to node_modules and the
 * handler's own code gets none; from it every project file does, which is `process` and `Buffer` being globals
 * as they are in Workers with `nodejs_compat`, and `process.env` holds the app's text bindings (POPULATE_PROCESS_ENV).
 */
const nodeGlobalsPlugin = (appOwned: boolean): import("bun").BunPlugin => ({
  name: "sproutboat-node-globals",
  setup(build) {
    build.onResolve({ filter: /^sb-node-process$/ }, () => ({ path: "sb-node-process", namespace: "sb-node-global" }));
    build.onLoad({ filter: /.*/, namespace: "sb-node-global" }, () => ({
      contents: processStub(appOwned),
      loader: "js",
    }));
    build.onLoad({ filter: appOwned ? APP_AND_DEPENDENCY_FILES : DEPENDENCY_FILES }, async (args) => {
      const original = await Bun.file(args.path).text();
      const text = original.replace(
        SHADOWED_BUILTIN_FUNCTIONS,
        (_m, lead: string, name: string) => `${lead}function ${name}_sb(`,
      );
      const usesBuffer =
        /(?:^|[^.\w$])Buffer\s*[.(]/m.test(text) &&
        !/\b(?:import|require)\b[^;\n]*\bBuffer\b/.test(text) &&
        !/(?:const|let|var)\s+\{?\s*Buffer\b/.test(text);
      const usesProcess =
        /(?:^|[^.\w$])process\s*\./m.test(text) &&
        !/\b(?:import|require)\b[^;\n]*\bprocess\b/.test(text) &&
        !/(?:const|let|var|function)\s+\{?\s*process\b/.test(text);
      const usesGlobal =
        /(?:^|[^.\w$])global\s*\./m.test(text) && !/(?:const|let|var|function)\s+\{?\s*global\b/.test(text);
      if (!usesBuffer && !usesProcess && !usesGlobal)
        return text === original ? undefined : { contents: text, loader: loaderOf(args.path) };
      const esm = /^\s*(?:import|export)\s/m.test(text);
      let prefix = "";
      if (usesBuffer) prefix += esm ? `import { Buffer } from "buffer";\n` : `var { Buffer } = require("buffer");\n`;
      if (usesProcess)
        prefix += esm
          ? `import process from "sb-node-process";\n`
          : `var process = require("sb-node-process").default;\n`;
      if (usesGlobal) prefix += "var global = globalThis;\n";
      return { contents: prefix + text, loader: loaderOf(args.path) };
    });
  },
});

const socketShimSpecifiers = new RegExp(
  `^(${Object.keys(SOCKET_NODE_SHIMS)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})$`,
);

/** The Node built-ins a driver names, replaced from the sockets date: see SOCKET_NODE_SHIMS. */
const socketShimsPlugin: import("bun").BunPlugin = {
  name: "sproutboat-socket-shims",
  setup(build) {
    build.onResolve({ filter: socketShimSpecifiers }, (args) => ({ path: args.path, namespace: "sb-socket-shim" }));
    build.onLoad({ filter: /.*/, namespace: "sb-socket-shim" }, (args) => ({
      // SAFETY: onResolve above only routes specifiers built from SOCKET_NODE_SHIMS's own keys here.
      contents: (SOCKET_NODE_SHIMS as Record<string, string>)[args.path],
      loader: "js",
    }));
  },
};

/** Bun reports resolution failures on `AggregateError.errors`; its own message is just "Bundle failed". */
function bundleDetail(cause: unknown): string {
  const errors = cause instanceof AggregateError ? cause.errors : [];
  if (errors.length > 0)
    return errors.map((error) => `  ${error instanceof Error ? error.message : String(error)}`).join("\n");
  return `  ${cause instanceof Error ? cause.message : String(cause)}`;
}

/** Bundle `entryPath` into a single module, resolving imports from `projectDir`. */
export async function bundleHandler(
  entryPath: string,
  projectDir: string,
  options: { compatibilityDate?: string } = {},
): Promise<BundleResult> {
  // From the sockets date a driver bundles as it does for workerd: its "workerd" export condition,
  // Node's free `Buffer`/`process`/`global` bound to bundled code, and net/tls/dns/fs/crypto shims
  // that name cloudflare:sockets when the driver takes its Node path.
  const sockets = options.compatibilityDate !== undefined && options.compatibilityDate >= SOCKETS_DATE;
  const appOwnedGlobals = options.compatibilityDate !== undefined && options.compatibilityDate >= PROCESS_GLOBAL_DATE;
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({
      entrypoints: [entryPath],
      root: projectDir,
      // `browser` keeps the output free of Node shims — a dependency that wants
      // `process` must fail the capability check, not get a polyfill smuggled in.
      target: "browser",
      format: "esm",
      // Readability over size: a compile error from Porffor should point at
      // something a human can find, and Porffor strips the binary anyway.
      minify: false,
      splitting: false,
      sourcemap: "none",
      conditions: sockets ? ["workerd", "worker"] : undefined,
      plugins: sockets ? [nodeShimsPlugin, socketShimsPlugin, nodeGlobalsPlugin(appOwnedGlobals)] : [nodeShimsPlugin],
      // WorkerEntrypoint, DurableObject, RpcTarget and env are runtime globals; the
      // compiler turns this import into them, so it stays in the bundle as written.
      external: ["cloudflare:workers", "cloudflare:sockets"],
    });
  } catch (cause) {
    // An unresolvable specifier arrives as an AggregateError whose `errors`
    // carry the useful part ("Could not resolve: ./missing.js"); the top-level
    // message is only "Bundle failed", which tells nobody which import broke.
    throw new BundleError(`could not bundle ${entryLabel(entryPath, projectDir)}:\n${bundleDetail(cause)}`);
  }

  if (!built.success) {
    const detail = built.logs.map((log) => `  ${log.message}`).join("\n");
    throw new BundleError(`could not bundle ${entryLabel(entryPath, projectDir)}:\n${detail}`);
  }
  const [output] = built.outputs;
  if (output === undefined) throw new BundleError("the bundler produced no output");

  return { code: await output.text() };
}
