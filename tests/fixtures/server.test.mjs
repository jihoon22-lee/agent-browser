import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

let child, base;
before(async () => {
  child = spawn(process.execPath, ["tests/fixtures/server.mjs", "--port", "0", "--alt-port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const [line] = await once(createInterface({ input: child.stdout }), "line");
  const info = JSON.parse(line);
  assert.equal(info.ready, true);
  base = `http://127.0.0.1:${info.port}`;
});
after(() => child.kill());

test("serves fixture pages", async () => {
  const res = await fetch(`${base}/search.html`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /검색어/);
});

test("records searches and counts duplicate submits", async () => {
  await fetch(`${base}/__reset`, { method: "POST" });
  await fetch(`${base}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: "브라우저", category: "도서" }) });
  for (let i = 0; i < 2; i++) {
    await fetch(`${base}/api/submit?delay=0`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "r1", fields: {} }) });
  }
  const log = await (await fetch(`${base}/__log`)).json();
  assert.deepEqual(log.events.find((e) => e.type === "search").body, { q: "브라우저", category: "도서" });
  assert.equal(log.submitCounts.r1, 2);
});

test("rejects path traversal", async () => {
  const res = await fetch(`${base}/..%2f..%2fetc/passwd`);
  assert.equal(res.status, 404);
});
