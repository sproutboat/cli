/**
 * `sproutboat deploy --prepare-out <dir>`: everything a Cloud deploy does before its first network call, written to a
 * directory. The Cloud's builder runs it in a sandbox for a Git deploy (sproutboat-cloud design 025) and lands it through
 * the same checks a laptop deploy goes through. No login, no network, no secrets.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAssetBlob, type AssetBundle, type ServiceRef } from "./cloud-deploy";
import type { CloudBindings, RecordBinding, RecordQueueConsumer } from "./cloud-bindings";

type PreparedSpec = {
  compatibility_date?: string;
  bindings?: RecordBinding[];
  crons?: string[];
  queue_consumers?: RecordQueueConsumer[];
  services?: ServiceRef[];
  workers_dev?: false;
};

export type PrepareOutInput = {
  outDir: string;
  project: string;
  generatedPath: string;
  cli: { version: string; runtime?: string; toolchain?: string };
  compatibilityDate: string | undefined;
  cloudBindings: CloudBindings;
  services: ServiceRef[];
  assets: AssetBundle | undefined;
  workersDev: boolean;
};

export function writePrepareOut(i: PrepareOutInput) {
  mkdirSync(join(i.outDir, "assets", "blobs"), { recursive: true });
  copyFileSync(i.generatedPath, join(i.outDir, "sprout.generated.js"));
  writeFileSync(join(i.outDir, "build.json"), `${JSON.stringify({ v: 1, name: i.project, cli: i.cli })}\n`);
  const spec: PreparedSpec = {};
  if (i.compatibilityDate !== undefined) spec.compatibility_date = i.compatibilityDate;
  if (i.cloudBindings.bindings.length > 0) spec.bindings = i.cloudBindings.bindings;
  if (i.cloudBindings.crons.length > 0) spec.crons = i.cloudBindings.crons;
  if (i.cloudBindings.queue_consumers.length > 0) spec.queue_consumers = i.cloudBindings.queue_consumers;
  if (!i.workersDev) spec.workers_dev = false;
  if (i.services.length > 0) spec.services = i.services.map(({ binding, service }) => ({ binding, service }));
  writeFileSync(join(i.outDir, "spec.json"), `${JSON.stringify(spec)}\n`);
  let assetFiles = 0;
  if (i.assets) {
    writeFileSync(join(i.outDir, "assets", "manifest.json"), i.assets.manifestText);
    for (const [hash, blob] of i.assets.blobs) {
      writeFileSync(join(i.outDir, "assets", "blobs", hash), readAssetBlob(blob));
      assetFiles++;
    }
  }
  return { files: 3 + (i.assets ? 1 : 0), assetFiles };
}
