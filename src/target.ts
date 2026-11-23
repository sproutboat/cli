/**
 * Which endpoint and stored profile a command talks to: the flags (`--api-url`, `--profile`), then the environment, then
 * the machine's active profile, then the default endpoint. A flag beats the other kind of variable. A profile fixes its
 * endpoint, so a profile next to a different URL is an error, never a quiet pick: a stored Community login must not deploy there.
 */
import { PROFILE_NAME } from "./credentials";

export type ProfileSource = "--profile" | "SPROUTBOAT_PROFILE" | "active profile";
export type UrlSource = "--api-url" | "SPROUTBOAT_API_URL" | "profile" | "default";

export type Target = {
  apiUrl: string;
  source: UrlSource;
  profile?: { name: string; source: ProfileSource; exists: boolean };
};

export type TargetInput = {
  flagUrl?: string;
  flagProfile?: string;
  envUrl?: string;
  envProfile?: string;
  profiles: Readonly<Record<string, { apiUrl: string }>>;
  activeProfile?: string;
  defaultUrl: string;
  allowNew?: boolean;
};

export class TargetError extends Error {}

const trim = (url: string) => url.replace(/\/$/, "");

export function chooseTarget(input: TargetInput): Target {
  const flagUrl = input.flagUrl ? trim(input.flagUrl) : undefined;
  const envUrl = input.envUrl ? trim(input.envUrl) : undefined;

  const named = (
    name: string,
    source: "--profile" | "SPROUTBOAT_PROFILE",
    otherUrl?: string,
    otherSource?: "--api-url" | "SPROUTBOAT_API_URL",
    newUrl?: string,
  ) => {
    if (!PROFILE_NAME.test(name))
      throw new TargetError(`${source} "${name}" is not a profile name (letters, digits, . _ -; at most 64)`);
    const stored = input.profiles[name];
    if (stored === undefined) {
      if (!input.allowNew) {
        const known = Object.keys(input.profiles);
        throw new TargetError(
          `no profile named "${name}"${known.length > 0 ? ` (profiles: ${known.join(", ")})` : ""}; create it with \`sproutboat login --profile ${name}\``,
        );
      }
      const apiUrl = otherUrl ?? newUrl ?? trim(input.defaultUrl);
      return {
        apiUrl,
        source:
          otherUrl !== undefined && otherSource ? otherSource : newUrl !== undefined ? "SPROUTBOAT_API_URL" : "default",
        profile: { name, source, exists: false },
      } satisfies Target;
    }
    const apiUrl = trim(stored.apiUrl);
    if (otherUrl !== undefined && otherUrl !== apiUrl)
      throw new TargetError(
        `the profile "${name}" is for ${apiUrl}, but ${otherSource} says ${otherUrl}; drop one of them`,
      );
    return { apiUrl, source: "profile", profile: { name, source, exists: true } } satisfies Target;
  };

  if (input.flagProfile !== undefined) return named(input.flagProfile, "--profile", flagUrl, "--api-url", envUrl);
  if (flagUrl !== undefined) return { apiUrl: flagUrl, source: "--api-url" };
  if (input.envProfile !== undefined) {
    // The environment names a profile and also a URL: they must be the same place.
    return named(input.envProfile, "SPROUTBOAT_PROFILE", envUrl, "SPROUTBOAT_API_URL");
  }
  if (envUrl !== undefined) return { apiUrl: envUrl, source: "SPROUTBOAT_API_URL" };
  const active = input.activeProfile;
  if (active !== undefined && input.profiles[active])
    return {
      apiUrl: trim(input.profiles[active].apiUrl),
      source: "profile",
      profile: { name: active, source: "active profile", exists: true },
    };
  return { apiUrl: trim(input.defaultUrl), source: "default" };
}
