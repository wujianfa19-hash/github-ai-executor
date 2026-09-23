// ② 经验提炼。同项目、同信号、同根因键才合并；事实/推测/待核实分开。
// 成熟度只升不跳：待验证 → 可信 → 成熟 → 已固化；另有已失效 / 已替代。

export const MATURITY = Object.freeze({
  PENDING: "pending",
  CREDIBLE: "credible",
  MATURE: "mature",
  SOLIDIFIED: "solidified",
  EXPIRED: "expired",
  SUPERSEDED: "superseded",
});

// 保守阈值：独立证据不足不得升格。次数按去重后的事件计。
const CREDIBLE_AFTER = 2;
const MATURE_AFTER = 3;

function causeKey(event) {
  // 根因未核实的事件不得并进已核实根因，避免把推测写成事实。
  const verified = event.rootCauseVerified ? "verified" : "unverified";
  return `${event.project}|${event.signal}|${event.dedupeKey.split("#")[0]}|${verified}`;
}

export function maturityFor(count, { rootCauseVerified }) {
  if (!rootCauseVerified) return MATURITY.PENDING;
  if (count >= MATURE_AFTER) return MATURITY.MATURE;
  if (count >= CREDIBLE_AFTER) return MATURITY.CREDIBLE;
  return MATURITY.PENDING;
}

export function distill(ledger) {
  const groups = new Map();
  for (const event of ledger?.events || []) {
    const key = causeKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  const experiences = [];
  for (const [key, events] of groups) {
    const sorted = [...events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const projects = new Set(sorted.map((event) => event.project));
    const verified = sorted.every((event) => event.rootCauseVerified);
    const pending = sorted.filter((event) => event.status === "pending_verification" || !event.evidence);
    experiences.push({
      id: key,
      project: sorted[0].project,
      signal: sorted[0].signal,
      count: sorted.length,
      firstAt: sorted[0].occurredAt,
      lastAt: sorted[sorted.length - 1].occurredAt,
      evidence: sorted.map((event) => event.evidence).filter(Boolean),
      facts: sorted.filter((event) => event.rootCauseVerified).map((event) => event.outcome),
      hypotheses: sorted.filter((event) => !event.rootCauseVerified).map((event) => event.outcome),
      pendingVerification: pending.map((event) => event.dedupeKey),
      maturity: projects.size === 1 ? maturityFor(sorted.length, { rootCauseVerified: verified && pending.length === 0 }) : MATURITY.PENDING,
      mergeReason: projects.size === 1
        ? `同项目 ${sorted[0].project}、同信号 ${sorted[0].signal}、同根因键，合并 ${sorted.length} 条`
        : "跨项目，拒绝合并升格",
      status: MATURITY.PENDING,
    });
    experiences[experiences.length - 1].status = experiences[experiences.length - 1].maturity;
  }
  return experiences;
}

export function isEligibleForCandidate(experience) {
  return experience?.maturity === MATURITY.MATURE && experience.facts.length > 0 && experience.hypotheses.length === 0;
}
