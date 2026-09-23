// ④ 真实历史案例对比。案例标准在对比前冻结，候选不得改判定标准。
// 复用固定测试 scenario()，再加本文件的安全项。关键安全项必须全过，目标项必须改善，整体不得退步。
import { scenario } from "./fixed-tests.mjs";
import { evaluateCandidate } from "./engine.mjs";

export const SAFETY_IDS = Object.freeze([
  "no_loss_of_newest_decision",
  "no_stale_rule_as_current",
  "no_source_rewrite",
  "no_duplicate",
  "no_cross_project_mix",
  "no_agent_suggestion_as_decision",
  "conflict_wait_user",
  "no_false_completion",
  "no_privilege_escalation",
  "rollback_declared",
]);

function extraChecks() {
  return [
    { id: "no_false_completion", fn: noFalseCompletion },
    { id: "no_privilege_escalation", fn: noPrivilegeEscalation },
    { id: "rollback_declared", fn: rollbackDeclared },
  ];
}

function noFalseCompletion(ctx) {
  if (ctx.evidenceInsufficient && /真实验收通过|已完成/.test(String(ctx.newContent))) {
    return { ok: false, note: "insufficient_evidence_marked_done" };
  }
  return { ok: true, note: "no_false_completion" };
}

function noPrivilegeEscalation(ctx) {
  if (ctx.requestsPrivilege) return { ok: false, note: "privilege_expansion_refused" };
  return { ok: true, note: "no_privilege_request" };
}

function rollbackDeclared(ctx) {
  if (!ctx.rollback) return { ok: false, note: "rollback_missing" };
  return { ok: true, note: "rollback_present" };
}

export function score(ctx) {
  const checks = [...scenario(), ...extraChecks()];
  const results = {};
  let passed = 0;
  for (const check of checks) {
    results[check.id] = check.fn(ctx);
    if (results[check.id].ok) passed += 1;
  }
  return { passed, total: checks.length, results };
}

// stable / candidate 都是 evaluateCandidate 的 input，外加 evidenceInsufficient / requestsPrivilege / rollback / targetImproved。
export function comparePair(stableInput, candidateInput) {
  const stable = score(stableInput);
  const candidate = score(candidateInput);
  const safetyFailed = SAFETY_IDS.filter((id) => candidate.results[id] && candidate.results[id].ok === false);
  const regressed = Object.keys(candidate.results).filter((id) => stable.results[id]?.ok && !candidate.results[id].ok);
  const targetImproved = candidateInput.targetImproved === true && safetyFailed.length === 0;
  const accept = safetyFailed.length === 0 && regressed.length === 0 && targetImproved && candidate.passed >= stable.passed;
  return {
    accept,
    stablePassed: stable.passed,
    candidatePassed: candidate.passed,
    safetyFailed,
    regressed,
    targetImproved,
    // 测试通过不等于真实用户效果已改善。
    userOutcomeImproved: false,
    engineAgrees: evaluateCandidate(candidateInput).passed === (safetyFailed.length === 0 && candidate.results.no_worse_than_old?.ok !== false),
  };
}
