/** Green/leaf terminal styling. Every helper is a no-op when stdout is not a TTY or NO_COLOR is set, so piped output stays plain. */
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint =
  (code: string) =>
  (text: string): string =>
    enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export const leaf = paint("32");
export const sprout = paint("92");
export const dim = paint("2");
export const bold = paint("1");
export const amber = paint("33");
export const rose = paint("31");

export const ok = (message: string): string => `${sprout("✓")} ${message}`;
export const step = (message: string): string => `${leaf("▸")} ${bold(message)}`;
