// 自我升级 runner - 固定测试
// 运行：node --test 02_程序组件/自我升级引擎/runner.test.mjs
// 验证 runner 的入口行为：合法候选→exit 0 且 adoptedContent 非空；禁止类→exit 1；绝不写任何文件。
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, "runner.mjs");
const LATEST = "最新已确认决定：选用方案B";

function runWith(candidate) {
  const dir = mkdtempSync(join(tmpdir(), "selfup-"));
  const file = join(dir, "candidate.json");
  writeFileSync(file, JSON.stringify(candidate));
  const res = spawnSync(process.execPath, [runner, file], { encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, dir };
}

const valid = {
  tag: "derived_summary",
  oldContent: "旧派生摘要：足够长的一段内容用于比较基线。",
  newContent: `${LATEST}\n[P5] 新派生摘要：比旧内容长度相当且保留了最新决定。`,
  latestDecision: LATEST,
  staleRules: [],
  sourceContent: null,
  project: "P5",
  conflict: false,
  isSuggestionOnly: false,
};

test("runner: 合法候选 exit 0 且 adoptedContent 非空", () => {
  const { status, stdout } = runWith(valid);
  assert.equal(status, 0, `exit0 expected, got ${status}\n${stdout}`);
  const rec = JSON.parse(stdout);
  assert.equal(rec.passed, true);
  assert.ok(rec.adoptedContent, "应给出可落盘的候选内容");
});

test("runner: 禁止类别 exit 1 且无 adoptedContent", () => {
  const { status, stdout } = runWith({ ...valid, tag: "user_decision" });
  assert.equal(status, 1, `exit1 expected, got ${status}`);
  const rec = JSON.parse(stdout);
  assert.equal(rec.passed, false);
  assert.equal(rec.adoptedContent, null);
  assert.ok(rec.failures.some((f) => f.includes("boundary")), "应为边界拒绝");
});

test("runner: 改写源内容 exit 1", () => {
  const source = "用户原始原话：这句话不能丢。";
  const { status, stdout } = runWith({ ...valid, newContent: "新摘要丢掉了原话。", sourceContent: source });
  assert.equal(status, 1);
  const rec = JSON.parse(stdout);
  assert.equal(rec.passed, false);
  assert.ok(rec.checks.no_source_rewrite.ok === false);
});

test("runner: 真正冲突 exit 1", () => {
  const { status, stdout } = runWith({ ...valid, conflict: true });
  assert.equal(status, 1);
  const rec = JSON.parse(stdout);
  assert.ok(rec.checks.conflict_wait_user.ok === false);
});

test("runner: 不产生任何副作用文件（不在临时目录写产物）", () => {
  const { dir } = runWith(valid);
  // runner 不应在候选目录旁创建任何文件（无写副作用）
  assert.deepEqual(readdirSync(dir), ["candidate.json"]);
  assert.equal(existsSync(join(dir, "adopted.txt")), false);
});