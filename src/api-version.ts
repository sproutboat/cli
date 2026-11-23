/**
 * Version skew between a CLI and a control plane, which update independently. Without a handshake it shows up as a 400
 * from a route that moved. The exchange is response-only: every `/api/` response carries the control plane's version and
 * the oldest CLI it supports; nothing is added to requests, so an old control plane sends no headers and nothing happens.
 */
import { isNewer } from "./update-check";

export const CONTROL_VERSION_HEADER = "x-sproutboat-control";
export const MIN_CLI_HEADER = "x-sproutboat-min-cli";

export function controlVersionWarning(response: Response, cliVersion: string): string | null {
  const min = response.headers.get(MIN_CLI_HEADER);
  // No header: a control plane older than this handshake. Nothing to say.
  if (!min || !isNewer(min, cliVersion)) return null;
  const control = response.headers.get(CONTROL_VERSION_HEADER);
  return (
    `this control plane${control ? ` (${control})` : ""} needs sproutboat ${min} or newer, ` +
    `and you are on ${cliVersion} — upgrade with \`bun add -g sproutboat@latest\``
  );
}
