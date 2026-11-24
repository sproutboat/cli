/** `tail` on the Sproutboat Cloud: GET /v1/apps/<app>/tail (live, SSE) and GET /v1/apps/<app>/logs (the host's recent lines). Needs logs:read. */
import { authHeaders, CloudError } from "./cloud";
import type { CloudCredentials } from "./cloud-deploy";
import { makeCall } from "./cloud-deploy";
import { isSafeInteger, isString, type JsonObject } from "./json";

export const DEFAULT_RECENT_LINES = 100;

const FORBIDDEN =
  "this key lacks the logs:read permission; ask a team Owner or Admin, or use a key that has it (see `sproutboat whoami` for this key's access)";
const notDeployed = (app: string) =>
  `${app} is not deployed on this team (or not found): run \`sproutboat deploy\` first, or pass --name <project> and --account <team>`;

/** The message for a refusal of the live route that retrying cannot fix; undefined leaves 5xx and the rest to the reconnect loop. */
export function explainTailRefusal(app: string, status: number, body: JsonObject | undefined): string | undefined {
  if (status === 401) return "this machine is not logged in, or its key was revoked; run `sproutboat login`";
  if (status === 403) return FORBIDDEN;
  if (status === 404) return notDeployed(app);
  if (status === 429 && body?.reason === "tail-viewers") {
    const scope = body.scope === "team" ? "this team" : body.scope === "host" ? "this app's server" : "this app";
    const wait = isSafeInteger(body.retry_after) ? ` in ${body.retry_after} s` : " in a minute";
    return `too many people are tailing ${scope} right now (5 per app, 10 per team); close another tail, or try again${wait}`;
  }
  if (status === 503 && body?.reason === "app-not-ready")
    return `${app} is deployed but its server is not running it yet; try again in a few minutes`;
  return undefined;
}

export function cloudTailRequest(credentials: CloudCredentials, app: string, query: string) {
  return {
    url: `${credentials.apiUrl}/v1/apps/${encodeURIComponent(app)}/tail${query ? `?${query}` : ""}`,
    headers: authHeaders(credentials.token),
  };
}

/** `times`: the time the host stored each line (ms since the epoch, null for a line an older host stored), when the control plane sends them (logs step 2 on). */
export type RecentLogs = { project: string; lines: string[]; times?: (number | null)[]; retention: string };

const STAMP = /^@(\d{13}) /;

/** The local time of a stored line, `2026-11-24 16:21:03.448` (the width of every stamp, so lines line up). */
export function logTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** The lines as printed: a stamped line starts with its time, an unstamped one (an older host's) keeps its text and is indented to line up, and with no stamp at all nothing changes. */
export function withTimes(lines: string[], times: (number | null)[] | undefined): string[] {
  if (!times || !times.some((t) => t !== null)) return lines;
  const blank = " ".repeat(logTime(0).length);
  return lines.map((line, i) => (times[i] == null ? `${blank} ${line}` : `${logTime(times[i]!)} ${line}`));
}

/** The last `lines` lines of the app's own output, oldest first, as the host keeps them: with the time each was stored where the host records it, no levels. */
export async function recentCloudLogs(credentials: CloudCredentials, app: string, lines: number): Promise<RecentLogs> {
  const result = await makeCall(credentials)({
    method: "GET",
    path: `/v1/apps/${encodeURIComponent(app)}/logs?lines=${lines}`,
    ok: [403, 404, 429, 503],
  });
  const refusal = result.status === 200 ? undefined : explainTailRefusal(app, result.status, result.body);
  if (refusal !== undefined) throw new CloudError(refusal);
  if (result.status === 429)
    throw new CloudError("too many log reads at once for this team; try again in a few seconds");
  if (result.status !== 200) {
    const detail = isString(result.body?.error) ? result.body.error : `HTTP ${result.status}`;
    throw new CloudError(`could not read the logs: ${detail}`);
  }
  const raw = result.body?.lines;
  let text = Array.isArray(raw) ? raw.filter(isString) : [];
  const sent = result.body?.times;
  let times: (number | null)[] | undefined =
    Array.isArray(sent) && sent.length === text.length ? sent.map((t) => (isSafeInteger(t) ? t : null)) : undefined;
  // A control plane that sends the lines with the host's stamp in them (`@<epoch ms> text`) is read the same way.
  if (!times && text.some((l) => STAMP.test(l))) {
    times = text.map((l) => (STAMP.test(l) ? Number(l.slice(1, 14)) : null));
    text = text.map((l) => l.replace(STAMP, ""));
  }
  const recent: RecentLogs = {
    project: app,
    lines: text,
    retention: isString(result.body?.retention) ? result.body.retention : "",
  };
  if (times) recent.times = times;
  return recent;
}

/** The runtime logs hide secret values of this many characters or more; a shorter one would mangle ordinary output, so it is not matched. */
export const REDACT_MIN_LENGTH = 8;

/** A warning for each secret too short to be hidden from the app's logs, or none. Names only, never a value. */
export function shortSecretWarnings(values: Record<string, string>): string[] {
  const short = Object.keys(values).filter((name) => values[name]!.length < REDACT_MIN_LENGTH);
  if (short.length === 0) return [];
  return [
    `${short.join(", ")} ${short.length === 1 ? "is" : "are"} shorter than ${REDACT_MIN_LENGTH} characters: the app's logs hide a secret value only from ${REDACT_MIN_LENGTH} characters up, so if the app prints ${short.length === 1 ? "it" : "them"} it will show in \`sproutboat tail\` and the dashboard`,
  ];
}
