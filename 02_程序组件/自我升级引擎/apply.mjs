// ⑥ 有界采用、监控、回滚。默认关闭。
// 只接受白名单路径、低风险、对比通过、影子达阈值、基线 SHA 仍一致的候选。
// 并发改动或冲突：停该候选，不覆盖。本模块不触碰永久大脑，只返回可审计决定。

export const DEFAULT_ALLOWLIST = Object.freeze([
  "02_当前工作台/P5_自我升级运行记录.md",
]);

const WRITEBACK = { enabled: false };

export function isWritebackEnabled() {
  return WRITEBACK.enabled === true;
}

export function decideAdoption(input) {
  const reasons = [];
  if (!isWritebackEnabled() && input.forceEnable !== true) reasons.push("writeback_disabled");
  if (!input.comparison?.accept) reasons.push("comparison_rejected");
  if (input.shadow?.status !== "threshold_met") reasons.push("shadow_not_ready");
  if (input.candidate?.autoApplyAllowed !== true) reasons.push("not_low_risk");
  if (!DEFAULT_ALLOWLIST.includes(input.candidate?.targetPath)) reasons.push("path_not_allowlisted");
  if (!input.baselineSha || input.baselineSha !== input.currentSha) reasons.push("baseline_moved");
  if (input.conflict) reasons.push("concurrent_conflict");
  if (!input.candidate?.rollback) reasons.push("rollback_missing");
  const adopt = reasons.length === 0;
  return {
    adopt,
    reasons,
    mode: adopt ? "bounded_write" : "shadow",
    rollback: input.candidate?.rollback || null,
    audit: {
      experienceId: input.candidate?.experienceId || null,
      targetPath: input.candidate?.targetPath || null,
      baselineSha: input.baselineSha || null,
      currentSha: input.currentSha || null,
      longRunAccepted: false,
    },
  };
}

// 指标变差时的回滚决定。只描述恢复点，不执行删除。
export function decideRollback({ metricWorse, hardRuleDamaged, previousSha }) {
  const trigger = Boolean(metricWorse) || Boolean(hardRuleDamaged);
  return {
    rollback: trigger,
    reason: hardRuleDamaged ? "hard_rule_damaged" : metricWorse ? "metric_worse" : null,
    restoreSha: trigger ? previousSha || null : null,
    keepFailureEvidence: trigger,
  };
}
