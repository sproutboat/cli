/**
 * #212: compat harness for the node:* shims in node-shims.ts. A hand-written comparison table against the real built-ins,
 * runnable under both `bun test` and `node --test`, is enough for these few functions; extend it rather than vendoring
 * Node's own tests unless a shim's surface grows a lot.
 */
import assert from "node:assert/strict";
import * as realPath from "node:path";
import * as realQuerystring from "node:querystring";
import { test } from "node:test";
import * as realUrl from "node:url";

// A literal "./node-shims.ts" specifier works under `node --test` but trips tsc's `moduleResolution: bundler` extension
// check; building the specifier avoids tsc resolving it statically.
async function loadShim(specifier: string): Promise<any> {
  const { NODE_SHIMS } = await import(["./node-shims", "ts"].join("."));
  const source = NODE_SHIMS[specifier];
  if (source === undefined) throw new Error(`no shim registered for ${specifier}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("node:path shim matches real node:path for cwd-independent operations", async () => {
  const shimPath = await loadShim("node:path");
  const paths = ["a/b", "/a/b/c.txt", "a/./b/../c", "", "/", "a.b.c/d.txt", "/a/b/"];

  for (const p of paths) {
    assert.equal(shimPath.normalize(p), realPath.normalize(p), `normalize(${JSON.stringify(p)})`);
    assert.equal(shimPath.isAbsolute(p), realPath.isAbsolute(p), `isAbsolute(${JSON.stringify(p)})`);
    assert.equal(shimPath.dirname(p), realPath.dirname(p), `dirname(${JSON.stringify(p)})`);
    assert.equal(shimPath.basename(p), realPath.basename(p), `basename(${JSON.stringify(p)})`);
    assert.equal(shimPath.extname(p), realPath.extname(p), `extname(${JSON.stringify(p)})`);
    assert.deepEqual(shimPath.parse(p), realPath.parse(p), `parse(${JSON.stringify(p)})`);
  }

  const joinCases: string[][] = [
    ["a", "b"],
    ["a/", "/b"],
    ["", "b"],
    ["a", "..", "b"],
    ["/a", "b", "c.txt"],
  ];
  for (const parts of joinCases) assert.equal(shimPath.join(...parts), realPath.join(...parts), `join(${parts})`);

  const relCases: [string, string][] = [
    ["/a/b", "/a/c"],
    ["/a/b/c", "/a/b"],
    ["a", "b"],
  ];
  for (const [from, to] of relCases) {
    // relative() calls resolve() internally, which real Node grounds in
    // process.cwd() and the shim grounds in a fixed "/" — comparable only
    // for already-absolute inputs, which is what these cases use.
    if (realPath.isAbsolute(from) && realPath.isAbsolute(to))
      assert.equal(shimPath.relative(from, to), realPath.relative(from, to), `relative(${from}, ${to})`);
  }

  // resolve() intentionally diverges: a compiled handler has no cwd, so the shim grounds an all-relative resolve() at a
  // fixed "/" instead of process.cwd(). Assert that directly rather than against Node's cwd-dependent value.
  assert.equal(shimPath.resolve("x/y"), "/x/y");
  assert.equal(shimPath.resolve("/x", "y"), realPath.resolve("/x", "y"));
});

test("node:querystring shim matches real node:querystring", async () => {
  const shimQs = await loadShim("node:querystring");
  const parseCases = ["a=1&b=2", "a=1&b=2&b=3", "", "a=hello%20world", "noeq&b=1", "a=b%26c"];
  for (const qs of parseCases)
    assert.deepEqual(shimQs.parse(qs), realQuerystring.parse(qs), `parse(${JSON.stringify(qs)})`);

  const stringifyCases: Record<string, string | string[]>[] = [
    { a: "1", b: "2" },
    { a: "1", b: ["2", "3"] },
    { "a b": "c&d" },
    {},
  ];
  for (const obj of stringifyCases)
    assert.equal(shimQs.stringify(obj), realQuerystring.stringify(obj), `stringify(${JSON.stringify(obj)})`);

  const escapeCases = ["a b", "a&b=c", "hello", "100% done"];
  for (const s of escapeCases) {
    assert.equal(shimQs.escape(s), realQuerystring.escape(s), `escape(${JSON.stringify(s)})`);
    assert.equal(shimQs.unescape(s), realQuerystring.unescape(s), `unescape(${JSON.stringify(s)})`);
  }
});

/** The URL/URLSearchParams re-export is identical to the global by construction; the value here is checking the
 * hand-written legacy parse/format/resolve against Node's for the common absolute-URL case. */
test("node:url shim matches real node:url for absolute URLs", async () => {
  const shimUrl = await loadShim("node:url");
  assert.equal(shimUrl.URL, globalThis.URL);
  assert.equal(shimUrl.URLSearchParams, globalThis.URLSearchParams);

  const urls = ["http://example.com/a/b?q=1", "https://user:pass@example.com:8080/p", "http://example.com/"];
  for (const href of urls) {
    // Node's parse() returns a `Url` instance; the shim returns a plain object. Spreading strips the prototype so the
    // comparison is field by field, which is what consumers of the legacy API read.
    assert.deepEqual({ ...shimUrl.parse(href) }, { ...realUrl.parse(href) }, `parse(${JSON.stringify(href)})`);
    assert.equal(shimUrl.format(new shimUrl.URL(href)), realUrl.format(new realUrl.URL(href)), `format(${href})`);
  }

  const resolveCases: [string, string][] = [
    ["http://example.com/a/", "b"],
    ["http://example.com/a/b", "../c"],
  ];
  for (const [from, to] of resolveCases)
    assert.equal(shimUrl.resolve(from, to), realUrl.resolve(from, to), `resolve(${from}, ${to})`);
});

test("node:async_hooks shim hands out the runtime's AsyncLocalStorage", async () => {
  class Stand {}
  Object.assign(globalThis, { AsyncLocalStorage: Stand });
  try {
    const shim = await loadShim("node:async_hooks");
    assert.equal(shim.AsyncLocalStorage, Stand);
    assert.equal(shim.default.AsyncLocalStorage, Stand);
  } finally {
    Reflect.deleteProperty(globalThis, "AsyncLocalStorage");
  }
});
