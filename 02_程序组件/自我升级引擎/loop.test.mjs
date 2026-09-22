import test from "node:test";
import assert from "node:assert/strict";
import { ingest } from "./ledger.mjs";
import { distill, MATURITY } from "./experience.mjs";
import { generateCandidates } from "./candidates.mjs";
import { comparePair } from "./compare.mjs";
import { shadowRun } from "./shadow.mjs";
import { decideAdoption, decideRollback, isWritebackEnabled } from "./apply.mjs";
import { runLoop } from "./loop.mjs";

const LATEST = "最新已确认决定：选用方案B";

function event(overrides = {}) {
  return {
    source: "executor-run",
    occurredAt: "2026-09-21T00:00:00Z",
    project: "P5",
    signal: "information_quality",
    outcome: "索引漏了最新决定",
    evidence: "run:35535728116",
    rootCauseVerified: true,
    scope: "index",
    dedupeKey: "p5-index-stale",
    ...overrides,
  };
}

function candidateInput(overrides = {}) {
  return {
    tag: "index",
    oldContent: `${LATEST}\n[P5] 旧索引`,
    newContent: `${LATEST}\n[P5] 新索引保留决定并补上来源`,
    latestDecision: LATEST,
    staleRules: [],
    sourceContent: null,
    project: "P5",
    conflict: false,
    isSuggestionOnly: false,
    evidenceInsufficient: false,
    requestsPrivilege: false,
    rollback: "删除本次运行记录文件",
    targetImproved: true,
    ...overrides,
  };
}

test("收集：连续两次同一键不重复，缺证据标待核实，拒绝可执行字段", () => {
  const first = ingest({ events: [], rejected: [] }, event());
  const second = ingest(first.ledger, event());
  assert.equal(second.duplicate, true);
  assert.equal(second.ledger.events.length, 1);
  const thin = ingest(second.ledger, event({ dedupeKey: "no-evidence", evidence: "" }));
  assert.equal(thin.ledger.events.at(-1).status, "pending_verification");
  assert.equal(thin.ledger.events.at(-1).rootCauseVerified, false);
  const bad = ingest(thin.ledger, event({ dedupeKey: "evil", command: "rm -rf" }));
  assert.equal(bad.accepted, false);
  assert.equal(bad.ledger.events.length, thin.ledger.events.length);
});

test("提炼：同根因合并并保留证据；跨项目不升格；一次证据不足保持待验证", () => {
  let ledger = { events: [], rejected: [] };
  for (let i = 0; i < 3; i += 1) {
    ledger = ingest(ledger, event({
      occurredAt: `2026-09-2${i + 1}T00:00:00Z`,
      dedupeKey: `p5-index-stale#${i}`,
      evidence: `commit:${i}`,
    })).ledger;
  }
  const merged = distill(ledger);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 3);
  assert.equal(merged[0].maturity, MATURITY.MATURE);
  assert.equal(merged[0].evidence.length, 3);
  assert.match(merged[0].mergeReason, /合并 3 条/);

  const once = distill(ingest({ events: [], rejected: [] }, event({ rootCauseVerified: false, evidence: null, dedupeKey: "once" })).ledger);
  assert.equal(once[0].maturity, MATURITY.PENDING);
  assert.ok(once[0].hypotheses.length >= 1);

  const cross = ingest(ledger, event({ project: "OTHER", dedupeKey: "p5-index-stale#x", evidence: "e" })).ledger;
  const mixed = distill({ events: cross.events.filter((item) => item.dedupeKey.endsWith("#x") || item.dedupeKey.endsWith("#0")).map((item, index) => ({ ...item, dedupeKey: index ? "same#1" : "same#0" })), rejected: [] });
  assert.ok(mixed.every((item) => item.project === "P5" || item.maturity === MATURITY.PENDING));
});

test("候选：无成熟经验时无合格候选；高风险信号不自动生效", () => {
  const pending = distill(ingest({ events: [], rejected: [] }, event({ rootCauseVerified: false })).ledger);
  const none = generateCandidates(pending, [{ experienceId: pending[0].id, tag: "index", targetPath: "02_当前工作台/P5_自我升级运行记录.md", baselineSha: "abc", expectedImprovement: "补索引", validation: "fixed-tests", rollback: "删除该文件" }]);
  assert.equal(none.candidates.length, 0);
  assert.equal(none.emptyReason, "无合格候选");

  let ledger = { events: [], rejected: [] };
  for (let i = 0; i < 3; i += 1) {
    ledger = ingest(ledger, event({ signal: "rule_problem", dedupeKey: `rule#${i}`, evidence: `e${i}`, outcome: "规则漏执行" })).ledger;
  }
  const mature = distill(ledger);
  const high = generateCandidates(mature, [{ experienceId: mature[0].id, tag: "index", targetPath: "02_当前工作台/P5_自我升级运行记录.md", baselineSha: "abc", expectedImprovement: "补检查", validation: "fixed-tests", rollback: "删除该文件" }]);
  assert.equal(high.candidates[0].autoApplyAllowed, false);
  assert.equal(high.candidates[0].risk, "high");
  assert.equal(high.candidates[0].instruction, false);
});

test("对比：安全项全过且目标改善才接受；证据不足冒充完成被拒绝；标准不被改写", () => {
  const stable = candidateInput({ targetImproved: false, newContent: `${LATEST}\n[P5] 旧索引保持` });
  const better = candidateInput();
  const ok = comparePair(stable, better);
  assert.equal(ok.accept, true);
  assert.equal(ok.userOutcomeImproved, false);

  const fakeDone = comparePair(stable, candidateInput({ evidenceInsufficient: true, newContent: `${LATEST}\n[P5] 真实验收通过` }));
  assert.equal(fakeDone.accept, false);
  assert.ok(fakeDone.safetyFailed.includes("no_false_completion"));

  const escalated = comparePair(stable, candidateInput({ requestsPrivilege: true }));
  assert.ok(escalated.safetyFailed.includes("no_privilege_escalation"));

  const conflict = comparePair(stable, candidateInput({ conflict: true }));
  assert.ok(conflict.safetyFailed.includes("conflict_wait_user"));

  const suggestion = comparePair(stable, candidateInput({ isSuggestionOnly: true, newContent: `${LATEST}\n[P5] 用户决定：就这么办，长度足够。` }));
  assert.ok(suggestion.safetyFailed.includes("no_agent_suggestion_as_decision"));
});

test("影子：样本不足保持观察；达阈值仍不改正式结果、不宣布长期验收", () => {
  const watching = shadowRun({ stableOutput: "a", candidateOutput: "b", samples: 1, safetyFailures: 0 });
  assert.equal(watching.status, "observing");
  assert.equal(watching.appliedToFormal, false);
  const met = shadowRun({ stableOutput: "a", candidateOutput: "b", samples: 5, safetyFailures: 0 });
  assert.equal(met.status, "threshold_met");
  assert.equal(met.longRunAccepted, false);
  assert.equal(met.divergences.length, 1);
});

test("采用与回滚：默认写回关闭；基线漂移停；演练回滚不丢失败证据", () => {
  assert.equal(isWritebackEnabled(), false);
  const comparison = comparePair(candidateInput({ targetImproved: false }), candidateInput());
  const shadow = shadowRun({ stableOutput: "a", candidateOutput: "a", samples: 5, safetyFailures: 0 });
  let ledger = { events: [], rejected: [] };
  for (let i = 0; i < 3; i += 1) ledger = ingest(ledger, event({ dedupeKey: `k#${i}`, evidence: `e${i}` })).ledger;
  const candidate = generateCandidates(distill(ledger), [{
    experienceId: distill(ledger)[0].id,
    tag: "run_log",
    targetPath: "02_当前工作台/P5_自我升级运行记录.md",
    baselineSha: "sha-1",
    expectedImprovement: "补运行记录",
    validation: "fixed-tests",
    rollback: "恢复 sha-0",
  }]).candidates[0];

  const blocked = decideAdoption({ candidate, comparison, shadow, baselineSha: "sha-1", currentSha: "sha-1", conflict: false });
  assert.equal(blocked.adopt, false);
  assert.ok(blocked.reasons.includes("writeback_disabled"));

  const moved = decideAdoption({ candidate, comparison, shadow, baselineSha: "sha-1", currentSha: "sha-2", conflict: false, forceEnable: true });
  assert.ok(moved.reasons.includes("baseline_moved"));
  assert.equal(moved.adopt, false);

  const conflicted = decideAdoption({ candidate, comparison, shadow, baselineSha: "sha-1", currentSha: "sha-1", conflict: true, forceEnable: true });
  assert.ok(conflicted.reasons.includes("concurrent_conflict"));

  const drill = decideRollback({ metricWorse: true, previousSha: "sha-0" });
  assert.equal(drill.rollback, true);
  assert.equal(drill.restoreSha, "sha-0");
  assert.equal(drill.keepFailureEvidence, true);
});

test("编排：没有合格候选，且长期验收保持未完成", () => {
  const report = runLoop({ events: [event({ rootCauseVerified: false, evidence: null })] });
  assert.equal(report.generated.emptyReason, "无合格候选");
  assert.equal(report.longRunAccepted, false);
  assert.equal(report.writebackEnabled, false);
  assert.equal(report.note, "长期自动迭代系统尚未验收完成");
});
