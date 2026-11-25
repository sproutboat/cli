import { afterEach, expect, test } from "bun:test";
import { CloudError, explainApiFailure } from "./cloud";
import { makeCall, retryAfterSeconds } from "./cloud-deploy";
import type { JsonObject } from "./json";

async function failureOf(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof CloudError) return error.message;
    throw error;
  }
  throw new Error("the call succeeded");
}

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

function cloud(answers: (n: number) => Response) {
  let n = 0;
  server = Bun.serve({ port: 0, fetch: () => answers(n++) });
  return {
    credentials: { apiUrl: `http://127.0.0.1:${server.port}`, token: "sbk_test", tokenFromEnv: false },
    count: () => n,
  };
}
const limited = (
  retryAfter: string | null,
  body: JsonObject = { error: "over", reason: "key-rate-limited", retry_after_s: 7 },
) => new Response(JSON.stringify(body), { status: 429, headers: retryAfter ? { "retry-after": retryAfter } : {} });

test("a 429 with retry-after waits that long and tries the same call again", async () => {
  const waits: number[] = [];
  const { credentials, count } = cloud((n) => (n < 2 ? limited("3") : Response.json({ ok: true })));
  const call = makeCall(credentials, { sleep: async (ms) => void waits.push(ms), onWait: () => {} });
  const reply = await call({ method: "GET", path: "/v1/apps" });
  expect(reply.status).toBe(200);
  expect(waits).toEqual([3000, 3000]);
  expect(count()).toBe(3);
});

test("with no header the body's retry_after_s is used", async () => {
  const waits: number[] = [];
  const { credentials } = cloud((n) => (n === 0 ? limited(null) : Response.json({})));
  await makeCall(credentials, { sleep: async (ms) => void waits.push(ms), onWait: () => {} })({
    method: "GET",
    path: "/v1/apps",
  });
  expect(waits).toEqual([7000]);
});

test("it gives up after five retries and says when to come back", async () => {
  const { credentials, count } = cloud(() => limited("2"));
  const call = makeCall(credentials, { sleep: async () => {}, onWait: () => {} });
  expect(await failureOf(call({ method: "GET", path: "/v1/apps" }))).toContain(
    "over its request limit; try again in 7 s",
  );
  expect(count()).toBe(6);
});

test("a wait longer than a minute is not slept through, and a caller that handles 429 itself gets it at once", async () => {
  const slow = cloud(() => limited("600"));
  const call = makeCall(slow.credentials, {
    sleep: async () => {
      throw new Error("slept");
    },
    onWait: () => {},
  });
  expect(await failureOf(call({ method: "GET", path: "/x" }))).toContain("over its request limit");
  server?.stop(true);
  const own = cloud(() => limited("1"));
  const reply = await makeCall(own.credentials, {
    sleep: async () => {
      throw new Error("slept");
    },
  })({ method: "POST", path: "/v1/domains", ok: [429] });
  expect(reply.status).toBe(429);
  expect(own.count()).toBe(1);
});

test("retryAfterSeconds reads the header first, then the body, and ignores nonsense", () => {
  expect(retryAfterSeconds(new Headers({ "retry-after": "4" }), { retry_after_s: 9 })).toBe(4);
  expect(retryAfterSeconds(new Headers(), { retry_after_s: 9 })).toBe(9);
  expect(retryAfterSeconds(new Headers({ "retry-after": "soon" }), { retry_after: 2 })).toBe(2);
  expect(retryAfterSeconds(new Headers(), undefined)).toBeUndefined();
});

test("the key limit is explained by name", () => {
  expect(
    explainApiFailure(429, JSON.stringify({ error: "x", reason: "key-rate-limited", retry_after_s: 13 }), false),
  ).toContain("try again in 13 s");
});
