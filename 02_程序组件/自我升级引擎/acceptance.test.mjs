import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assessObservation } from "./history-gate.mjs";
import { applyBoundedWrite, rollbackBoundedWrite, sha256 } from "./bounded-write.mjs";

function observed(date, overrides = {}) {
  return {
    occurredAt: `${date}T01:00:00Z`,
    evidence: `run:${date}`,
    status: "verified",
    ...overrides,
  };
}

test("观察门禁：同日重复不凑数，5 个真实日期才通过", () => {
  const events = [
    observed("2026-09-13"),
    observed("2026-09-13", { evidence: "run:duplicate" }),
    observed("2026-09-14"),
    observed("2026-09-15"),
    observed("2026-09-16"),
    observed("2026-09-17"),
    observed("2026-09-18", { status: "pending_verification" }),
  ];
  const result = assessObservation(events);
  assert.equal(result.passed, true);
  assert.equal(result.observedDays, 5);
  assert.equal(result.acceptedEvents, 6);
});

test("有界写入：真实写文件、基线漂移拒绝、可恢复原内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "p5-bounded-"));
  const relativePath = "02_当前工作台/P5_自我升级运行记录.md";
  const target = join(root, relativePath);
  await mkdir(join(root, "02_当前工作台"), { recursive: true });
  const oldContent = "[P5] 稳定版\n";
  const newContent = "[P5] 稳定版\n[P5] 低风险派生运行记录\n";
  await writeFile(target, oldContent, "utf8");

  await assert.rejects(
    applyBoundedWrite({
      root,
      relativePath,
      allowlist: [relativePath],
      expectedSha256: "wrong",
      newContent,
    }),
    /baseline_moved/,
  );

  const applied = await applyBoundedWrite({
    root,
    relativePath,
    allowlist: [relativePath],
    expectedSha256: sha256(oldContent),
    newContent,
  });
  assert.equal(await readFile(target, "utf8"), newContent);
  assert.notEqual(applied.beforeSha256, applied.afterSha256);

  const rolledBack = await rollbackBoundedWrite({
    applied,
    expectedCurrentSha256: applied.afterSha256,
  });
  assert.equal(await readFile(target, "utf8"), oldContent);
  assert.equal(rolledBack.restoredSha256, sha256(oldContent));
  assert.equal(rolledBack.failureEvidencePreserved, true);
});

test("有界写入：越界路径和白名单外路径均拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "p5-path-"));
  await assert.rejects(
    applyBoundedWrite({
      root,
      relativePath: "../escape.md",
      allowlist: ["../escape.md"],
      expectedSha256: "x",
      newContent: "x",
    }),
    /path_escape/,
  );
  await assert.rejects(
    applyBoundedWrite({
      root,
      relativePath: "not-allowed.md",
      allowlist: [],
      expectedSha256: "x",
      newContent: "x",
    }),
    /path_not_allowlisted/,
  );
});
