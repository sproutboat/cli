#!/usr/bin/env bun
/**
 * The same binding conformance checks as harness.ts, against a standalone binary. Both run `runConformance` unchanged: two
 * backends, one definition of what `env.KV.get` means.
 */
import { runStandalone } from "../lib/backends";
import { runConformance } from "./conformance";

await runStandalone({
  dir: import.meta.dir,
  label: "conformance",
  adminToken: "s3cr3t-admin",
  vars: (upstream) => ({ QUOTE_URL: `http://${upstream}/random` }),
  run: (context) => runConformance(context, { skipTriggers: true, skipServices: true }),
});
