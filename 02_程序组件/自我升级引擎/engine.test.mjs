// 自我升级引擎 - 固定测试
// 运行：node --test 02_程序组件/自我升级引擎/engine.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { canAutoApply, classify } from "./categories.mjs";
import { evaluateCandidate } from "./engine.mjs";

const LATEST = "最新已确认决定：选用方案B";

function baseInput(overrides = {}) {
  return {
    tag: "derived_summary",
    oldContent: "旧派生摘要：这是一段足够长的旧内容用于比较。",
    newContent: `${LATEST}\n[PROJECT] 新派生摘要：这是一段足够长的、相比旧内容没有明显缩水的新内容。`,
    latestDecision: LATEST,
    staleRules: [],
    sourceContent: null,
    project: "PROJECT",
    conflict: false,
    isSuggestionOnly: false,
    ...overrides,
  };
}

test("classification: 允许类别返回 allowed（derived）", () => {
  assert.equal(canAutoApply("derived_summary").ok, true);
  assert.equal(canAutoApply("index").ok, true);
  assert.equal(canAutoApply("run_log").ok, true);
  assert.equal(classify("navigation").kind, "allowed");
});

test("classification: 禁止类别一律拒绝，永不自动改", () => {
  for (const tag of ["user_rule", "user_decision", "source_content", "original_evidence", "security_boundary", "important_history", "true_conflict", "unknown", undefined]) {
    const r = canAutoApply(tag);
    assert.equal(r.ok, false, `应拒绝 ${tag}`);
    assert.ok(r.reason.startsWith("forbidden"), `reason 应为 forbidden: ${r.reason}`);
  }
});

test("evaluate: 正常候选全部固定测试通过 → 采用", () => {
  const record = evaluateCandidate(baseInput());
  assert.equal(record.passed, true, JSON.stringify(record.failures));
  assert.equal(record.adoptedContent, baseInput().newContent);
});

test("evaluate: 禁止类别即使内容再合理也不采用", () => {
  const record = evaluateCandidate(baseInput({ tag: "user_decision" }));
  assert.equal(record.passed, false);
  assert.ok(record.failures.some((f) => f.includes("boundary")), "应为边界拒绝");
});

test("evaluate: 丢弃最新已确认决定 → 拒绝", () => {
  const record = evaluateCandidate(baseInput({ newContent: "新摘要：但丢失了最新决定。旧句较长较长。" }));
  // 注意 notWorseThanOld 通过，但 latestDecision 丢失 → 应失败
  assert.equal(record.passed, false);
  assert.ok(record.checks.no_loss_of_newest_decision.ok === false);
});

test("evaluate: 让已废弃旧规则复活 → 拒绝", () => {
  const oldContent = "旧规则：以前动不动就 A，已被废弃。基线长句。";
  const newContent = "新规则：应重新启用 A。这一句足够长以通过长度检查。";
  const record = evaluateCandidate(baseInput({ oldContent, newContent, staleRules: ["A"] }));
  assert.equal(record.passed, false);
  assert.ok(record.checks.no_stale_rule_as_current.ok === false);
});

test("evaluate: 改写用户源内容 → 拒绝", () => {
  const source = "用户原始原话：绝对不能删除我这句话。";
  const newContent = "新摘要：用户说过一句话（不再保留原话）。";
  const record = evaluateCandidate(baseInput({ newContent, sourceContent: source }));
  assert.equal(record.passed, false);
  assert.ok(record.checks.no_source_rewrite.ok === false);
});

test("evaluate: 真正冲突必须停下等用户 → 拒绝", () => {
  const record = evaluateCandidate(baseInput({ conflict: true }));
  assert.equal(record.passed, false);
  assert.ok(record.checks.conflict_wait_user.ok === false);
});

test("evaluate: 把代理建议写成用户决定 → 拒绝", () => {
  const newContent = `${LATEST}\n\n用户决定：启用推荐策略。这一长句用于通过长度检查。`;
  const record = evaluateCandidate(baseInput({ newContent, isSuggestionOnly: true }));
  assert.equal(record.passed, false);
  assert.ok(record.checks.no_agent_suggestion_as_decision.ok === false);
});

test("evaluate: 新内容严重缩水（比旧版差）→ 拒绝", () => {
  const newContent = "太短"; // 大幅缩水
  const record = evaluateCandidate(baseInput({ newContent }));
  assert.equal(record.passed, false);
  assert.ok(record.checks.no_worse_than_old.ok === false);
});

test("evaluate: 内容正常但缺项目标记 → 拒绝（防串项目）", () => {
  // 带项目标记时会通过；这里用无标记新内容且来源要求有标记
  const record = evaluateCandidate(baseInput({ project: "P5", newContent: "新摘要没有项目标记但长度足够通过长度检查。" }));
  assert.equal(record.passed, false);
  assert.ok(record.checks.no_cross_project_mix.ok === false);
});