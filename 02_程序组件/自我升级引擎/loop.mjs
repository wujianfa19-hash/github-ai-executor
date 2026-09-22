// 六环编排。默认影子模式，不写永久大脑，不把模拟通过写成长期验收。
import { ingestBatch } from "./ledger.mjs";
import { distill } from "./experience.mjs";
import { generateCandidates } from "./candidates.mjs";
import { comparePair } from "./compare.mjs";
import { shadowRun } from "./shadow.mjs";
import { decideAdoption, decideRollback, isWritebackEnabled } from "./apply.mjs";

export function runLoop({ events, baselines, comparison, shadow, adoption, rollback }) {
  const collected = ingestBatch({ events: [], rejected: [] }, events || []);
  const experiences = distill(collected.ledger);
  const generated = generateCandidates(experiences, baselines || []);
  const compared = comparison ? comparePair(comparison.stable, comparison.candidate) : null;
  const shadowed = shadow ? shadowRun(shadow) : { status: "not_started", appliedToFormal: false, longRunAccepted: false };
  const decision = adoption
    ? decideAdoption({ ...adoption, comparison: compared, shadow: shadowed })
    : { adopt: false, mode: "shadow", reasons: ["no_adoption_requested"] };
  const recovery = rollback ? decideRollback(rollback) : { rollback: false };
  return {
    rings: {
      collect: collected.ledger.events.length ? "代码完成待验" : "未开始",
      distill: experiences.length ? "代码完成待验" : "未开始",
      candidates: generated.emptyReason || "代码完成待验",
      compare: compared ? "代码完成待验" : "未开始",
      shadow: shadowed.status === "threshold_met" ? "待持续观察" : shadowed.status,
      adopt: decision.adopt ? "代码完成待验" : "未启用",
    },
    collected,
    experiences,
    generated,
    compared,
    shadowed,
    decision,
    recovery,
    writebackEnabled: isWritebackEnabled(),
    longRunAccepted: false,
    note: "长期自动迭代系统尚未验收完成",
  };
}
