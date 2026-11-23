/**
 * The machines a binary can be built for. `linux-x86_64` is the deploy target (static musl); `linux-arm64` is the same
 * build for an aarch64 box and exists for `--standalone` only, since the platform runs x86_64.
 */
export type LinuxTarget = "linux-x86_64" | "linux-arm64";
export type BuildTarget = LinuxTarget | "host";

type LinuxInfo = {
  arch: "x86_64" | "aarch64";
  triple: string;
  platform: "linux/amd64" | "linux/arm64";
};

export const LINUX_TARGETS = {
  "linux-x86_64": { arch: "x86_64", triple: "x86_64-linux-musl", platform: "linux/amd64" },
  "linux-arm64": { arch: "aarch64", triple: "aarch64-linux-musl", platform: "linux/arm64" },
} satisfies Record<LinuxTarget, LinuxInfo>;

const ALIASES = new Map<string, BuildTarget>([
  ["host", "host"],
  ["linux-x86_64", "linux-x86_64"],
  ["linux-x64", "linux-x86_64"],
  ["linux-amd64", "linux-x86_64"],
  ["x86_64-linux", "linux-x86_64"],
  ["linux-arm64", "linux-arm64"],
  ["linux-aarch64", "linux-arm64"],
  ["aarch64-linux", "linux-arm64"],
]);

export function parseTarget(value: string | undefined): BuildTarget | undefined {
  return value === undefined ? undefined : ALIASES.get(value);
}

export const TARGET_NAMES = "host | linux-x64 | linux-arm64";

export function isLinuxTarget(target: BuildTarget): target is LinuxTarget {
  return target !== "host";
}

/** The Zig triple for a Linux target; x86_64 for anything else, which is what Porffor builds by default. */
export function linuxTriple(target: BuildTarget | undefined): string {
  return LINUX_TARGETS[target === "linux-arm64" ? "linux-arm64" : "linux-x86_64"].triple;
}
