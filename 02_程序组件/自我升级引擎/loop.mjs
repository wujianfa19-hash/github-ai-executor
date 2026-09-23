// 六环编排。默认影子模式，不写永久大脑，不把模拟通过写成长期验收。
import { ingestBatch } from "./ledger.mjs";
import { distill } from "./experience.mjs";
import { generateCandidates } from "./candidates.mjs";
import { comparePair } from "./compare.mjs";
import { shadowRun } from "./shadow.mjs";
import { decideAdoption, decideRollback, isWritebackEnabled } from "./apply.mjs";
import { assessObservation } from "./history-gate.mjs";

export function runLoop({ events, baselines, comparison, shadow, adoption, rollback, writeResult }) {
  const collected = ingestBatch({ events: [], rejected: [] }, events || []);
  const observation = assessObservation(collected.ledger.events);
  const experiences = distill(collected.ledger);
  const generated = generateCandidates(experiences, baselines || []);
  const compared = comparison ? comparePair(comparison.stable, comparison.candidate) : null;
  const shadowed = shadow ? shadowRun(shadow) : { status: "not_started", appliedToFormal: false, longRunAccepted: false };
  const decision = adoption
    ? decideAdoption({ ...adoption, comparison: compared, shadow: shadowed })
    : { adopt: false, mode: "shadow", reasons: ["no_adoption_requested"] };
  const recovery = rollback ? decideRollback(rollback) : { rollback: false };
  // V1 技术验收必须同时有真实跨日观察、完整门禁和已验证的写入/回滚。
  // 这不等于真实用户效果已改善，后者仍由后续运行持续观察。
  const longRunAccepted = Boolean(
    observation.passed
    && compared?.accept
    && shadowed.status === "threshold_met"
    && decision.adopt
    && writeResult?.status === "applied"
    && writeResult?.rollbackDrillPassed === true
  );
  return {
    rings: {
      collect: longRunAccepted ? "验收完成" : collected.ledger.events.length ? "代码完成待验" : "未开始",
      distill: longRunAccepted ? "验收完成" : experiences.length ? "代码完成待验" : "未开始",
      candidates: longRunAccepted ? "验收完成" : generated.emptyReason || "代码完成待验",
      compare: longRunAccepted ? "验收完成" : compared ? "代码完成待验" : "未开始",
      shadow: longRunAccepted ? "验收完成" : shadowed.status === "threshold_met" ? "门槛已满足" : shadowed.status,
      adopt: longRunAccepted ? "验收完成" : decision.adopt ? "待确认写入" : "未启用",
    },
    observation,
    collected,
    experiences,
    generated,
    compared,
    shadowed,
    decision,
    recovery,
    writebackEnabled: isWritebackEnabled(),
    longRunAccepted,
    userOutcomeImproved: compared?.userOutcomeImproved === true,
    note: longRunAccepted
      ? "V1 受控技术闭环已验收；真实用户效果继续观察"
      : "长期自动迭代系统尚未验收完成",
  };
}
