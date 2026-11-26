/**
 * Secrets on the Sproutboat Cloud, Wrangler style: `secrets put/list/delete` act on the deployed app by name, and a
 * deploy never wipes them. The Cloud routes: GET /v1/apps/<app>/secrets, PUT and DELETE /v1/apps/<app>/secrets/<NAME>.
 */
import { BINDING_NAME } from "./config";
import { readEnvFile } from "./env-file";
import { CloudError } from "./cloud";
import { makeCall, type CloudCredentials } from "./cloud-deploy";
import { isSafeInteger, isString, jsonObject, type JsonObject } from "./json";

export const SECRET_NAME_RE = BINDING_NAME;

type SecretAction = "list" | "write";
const PERMISSION = { list: "secret:list", write: "secret:write" } as const satisfies Record<SecretAction, string>;

const notDeployed = (project: string) =>
  `${project} is not deployed yet, so it has nowhere to keep secrets: run \`sproutboat deploy\` first, or pass them on the first deploy with --secrets-file <file>`;

async function secretCall(
  credentials: CloudCredentials,
  project: string,
  action: SecretAction,
  c: { method: string; path: string; json?: object },
  missingSecret?: string,
) {
  const result = await makeCall(credentials)({ ...c, ok: [403, 404] });
  if (result.status === 403)
    throw new CloudError(
      `this key lacks the ${PERMISSION[action]} permission; ask a team Owner or Admin, or use a key that has it (see \`sproutboat whoami\` for this key's access)`,
    );
  if (result.status === 404) {
    const error = result.body?.error;
    if (missingSecret !== undefined && isString(error) && error !== "no such app")
      throw new CloudError(`${project} has no secret named ${missingSecret}`);
    throw new CloudError(notDeployed(project));
  }
  return result;
}

/**
 * The names a deploy binds besides the config's: what the app already stores. A new app has none, and a key without `secret:list` cannot see them
 * (the deploy goes on with the declared ones and says so), so neither stops a deploy.
 */
export async function storedSecretNames(
  credentials: CloudCredentials,
  project: string,
): Promise<{ names: string[]; warning?: string }> {
  try {
    const result = await makeCall(credentials)({ method: "GET", path: `/v1/apps/${project}/secrets`, ok: [403, 404] });
    if (result.status === 404) return { names: [] };
    if (result.status === 403)
      return {
        names: [],
        warning:
          "this key lacks secret:list, so stored secrets the config does not declare are not bound by this deploy; declare them in the config or use a key that has it",
      };
    const names = result.body?.secrets;
    return { names: (Array.isArray(names) ? names.filter(isString) : []).filter((name) => SECRET_NAME_RE.test(name)) };
  } catch (error) {
    return {
      names: [],
      warning: `could not list the app's stored secrets (${error instanceof Error ? error.message : String(error)}); only the declared ones are bound`,
    };
  }
}

export async function listCloudSecrets(credentials: CloudCredentials, project: string): Promise<string[]> {
  const result = await secretCall(credentials, project, "list", {
    method: "GET",
    path: `/v1/apps/${project}/secrets`,
  });
  const names = result.body?.secrets;
  return Array.isArray(names) ? names.filter(isString) : [];
}

/** What the Cloud adds to a secrets write: a stored secret that the app's bindings do not declare never reaches the Worker's env. */
export type SecretWarning = { code: string; name: string; message: string; fix: string };

export type SecretWrite = { generation: number | undefined; warnings: SecretWarning[] };

function secretWrite(body: JsonObject | undefined): SecretWrite {
  const generation = body?.record_generation;
  const warnings: SecretWarning[] = [];
  const sent = body?.warnings;
  if (Array.isArray(sent))
    for (const entry of sent) {
      const w = jsonObject(entry);
      if (w && isString(w.code) && isString(w.name) && isString(w.message))
        warnings.push({ code: w.code, name: w.name, message: w.message, fix: isString(w.fix) ? w.fix : "" });
    }
  return { generation: isSafeInteger(generation) ? generation : undefined, warnings };
}

/** One line per warning: what happened, then the exact fix. */
export function secretWarningLines(warnings: SecretWarning[]): string[] {
  return warnings.map((w) => (w.fix ? `${w.message}; ${w.fix}` : w.message));
}

export async function putCloudSecret(
  credentials: CloudCredentials,
  project: string,
  name: string,
  value: string,
): Promise<SecretWrite> {
  const result = await secretCall(credentials, project, "write", {
    method: "PUT",
    path: `/v1/apps/${project}/secrets/${name}`,
    json: { value },
  });
  return secretWrite(result.body);
}

type SecretsPatchBody = { set?: Record<string, string>; delete?: string[] };

export async function patchCloudSecrets(
  credentials: CloudCredentials,
  project: string,
  patch: { set: Record<string, string>; delete: string[] },
): Promise<SecretWrite> {
  const body: SecretsPatchBody = {};
  if (Object.keys(patch.set).length > 0) body.set = patch.set;
  if (patch.delete.length > 0) body.delete = patch.delete;
  const result = await secretCall(credentials, project, "write", {
    method: "PATCH",
    path: `/v1/apps/${project}/secrets`,
    json: body,
  });
  return secretWrite(result.body);
}

export async function deleteCloudSecret(
  credentials: CloudCredentials,
  project: string,
  name: string,
): Promise<number | undefined> {
  const result = await secretCall(
    credentials,
    project,
    "write",
    { method: "DELETE", path: `/v1/apps/${project}/secrets/${name}` },
    name,
  );
  const generation = result.body?.record_generation;
  return isSafeInteger(generation) ? generation : undefined;
}

/**
 * The values of `deploy --secrets-file <file>`: a `.dev.vars` or `.env` file, read with `dev`'s dotenv parser. Only the
 * file named is read; `.dev.vars` is never picked up implicitly on a deploy, as with the Community deploy. Names
 * only in every message.
 */
export async function readSecretsFile(path: string): Promise<{ values: Record<string, string>; warnings: string[] }> {
  const parsed = await readEnvFile(path);
  const values: Record<string, string> = {};
  const bad: string[] = [];
  const skipped: string[] = [];
  for (const entry of parsed.entries) {
    if (!SECRET_NAME_RE.test(entry.key)) bad.push(entry.key);
    else if (entry.value === "") skipped.push(entry.key);
    else values[entry.key] = entry.value;
  }
  if (bad.length > 0)
    throw new CloudError(
      `${path}: secret names must be JavaScript identifiers (letters, digits, _); not valid: ${bad.join(", ")}`,
    );
  const warnings = [...parsed.warnings];
  if (skipped.length > 0) warnings.push(`${path}: not sent, empty value: ${skipped.join(", ")}`);
  return { values, warnings };
}
