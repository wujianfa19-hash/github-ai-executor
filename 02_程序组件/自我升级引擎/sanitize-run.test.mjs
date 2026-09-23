import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeRun, sanitizeRuns } from "./sanitize-run.mjs";
import { runLoop } from "./loop.mjs";

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/public-runs-20260920-22.json"), "utf8"));

test("脱敏：只留公开元数据，根因一律未核实", () => {
  const { events, rejected } = sanitizeRuns(fixture);
  assert.equal(rejected.length, 0);
  assert.equal(events.length, fixture.length);
  for (const event of events) {
    assert.equal(event.rootCauseVerified, false);
    assert.equal(event.status, "pending_verification");
    assert.match(event.evidence, /^https:\/\/github.com\/wujianfa19-hash\/github-ai-executor\/actions\/runs\/\d+$/);
    assert.equal(JSON.stringify(event).includes("sk-"), false);
  }
  const dates = new Set(events.map((event) => event.occurredAt.slice(0, 10)));
  assert.ok(dates.size < 5, "样本不足 5 个不同日期，不能当作观察完成");
});

test("脱敏：日志、密钥和多余字段拒绝", () => {
  assert.equal(sanitizeRun({ ...fixture[0], logs: "secret sk-abc" }).ok, false);
  assert.equal(sanitizeRun({ ...fixture[0], name: "token leak" }).ok, false);
  assert.equal(sanitizeRun({ ...fixture[0], url: "https://user:ghp_abcdefghijklmnopqrstuvwxyz123456@github.com" }).ok, false);
});

test("接入后仍无合格候选，写回关闭，验收未完成", () => {
  const { events } = sanitizeRuns(fixture);
  const report = runLoop({ events });
  assert.equal(report.generated.emptyReason, "无合格候选");
  assert.equal(report.writebackEnabled, false);
  assert.equal(report.longRunAccepted, false);
  assert.equal(report.collected.ledger.events.length, events.length);
});
