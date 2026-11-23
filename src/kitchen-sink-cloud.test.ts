import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// A Cloud build must reproduce the shared generation's units byte for byte. A free reference to a node global its shared
// prelude does not own makes the compiler import the node module behind it, and the builder answers `abi_rejected`
// (performance.now() did, against ABI b327ad41). Use Date.now() and friends instead.
const CLOUD_UNSAFE_GLOBALS = [
  "performance",
  "PerformanceObserver",
  "process",
  "Buffer",
  "setImmediate",
  "clearImmediate",
  "MessageEvent",
  "MessageChannel",
];

test("dogfood/kitchen-sink source stays buildable on a Cloud generation (no free node globals)", async () => {
  const source = await readFile(join(import.meta.dir, "../dogfood/kitchen-sink/src/index.js"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const found = CLOUD_UNSAFE_GLOBALS.filter((name) => new RegExp(`(?<![.\\w$])${name}\\b`).test(code));
  expect(found).toEqual([]);
});
