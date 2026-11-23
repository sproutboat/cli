#!/usr/bin/env bun
/**
 * The binding conformance checks against the broker backend: a host sprout, an in-process broker and a stub upstream. The
 * local stand-in for the platform, whose supervisor spawns the same broker per deployment (see test/fixtures/lib/backends.ts).
 */
import { runBroker } from "../lib/backends";
import { runConformance } from "./conformance";

await runBroker({
  dir: import.meta.dir,
  label: "conformance",
  adminToken: "s3cr3t-admin",
  vars: (upstream) => ({ QUOTE_URL: `http://${upstream}/random` }),
  run: (context) => runConformance(context, { skipDirectTransfer: true }),
});
