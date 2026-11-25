/** The line a legacy `sproutboat.jsonc` draws on stderr; tests that assert a quiet stderr on a legacy fixture drop it first. */
export const withoutNotice = (stderr: string): string =>
  stderr
    .split("\n")
    .filter((line) => !line.startsWith("! sproutboat.jsonc is deprecated:"))
    .join("\n");
