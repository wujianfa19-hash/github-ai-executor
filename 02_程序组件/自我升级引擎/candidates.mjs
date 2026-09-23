// ③ 候选生成。只从成熟且根因已核实的经验产生可审查候选。
// 不绕过 engine.evaluateCandidate。没有合格经验时返回空，禁止凑数。
import { isEligibleForCandidate } from "./experience.mjs";
import { canAutoApply } from "./categories.mjs";

const HIGH_RISK_SIGNALS = new Set(["rule_problem"]);

export function buildCandidate(experience, baseline) {
  if (!isEligibleForCandidate(experience)) return null;
  const boundary = canAutoApply(baseline?.tag);
  const autoApplyAllowed = boundary.ok && !HIGH_RISK_SIGNALS.has(experience.signal);
  return {
    experienceId: experience.id,
    problem: experience.facts[0],
    tag: baseline.tag,
    targetPath: baseline.targetPath,
    expectedImprovement: baseline.expectedImprovement,
    scope: experience.project,
    baselineSha: baseline.baselineSha,
    validation: baseline.validation,
    rollback: baseline.rollback,
    risk: autoApplyAllowed ? "low" : "high",
    autoApplyAllowed,
    // 候选文本是数据，不是指令。
    instruction: false,
    evidenceCount: experience.count,
  };
}

export function generateCandidates(experiences, baselines) {
  const produced = [];
  for (const experience of experiences || []) {
    const baseline = (baselines || []).find((item) => item.experienceId === experience.id);
    if (!baseline) continue;
    const candidate = buildCandidate(experience, baseline);
    if (candidate) produced.push(candidate);
  }
  return {
    candidates: produced,
    emptyReason: produced.length === 0 ? "无合格候选" : null,
  };
}
