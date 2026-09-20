import crypto from "node:crypto";

export const DAY_MS = 86_400_000;

export function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

export function daysAgo(iso, now = new Date()) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return 9999;
  return Math.max(0, (now.getTime() - t) / DAY_MS);
}

export function recencyScore(iso, now = new Date()) {
  const days = daysAgo(iso, now);
  if (days <= 1) return 30;
  if (days <= 3) return 25;
  if (days <= 7) return 20;
  if (days <= 30) return 14;
  return 5;
}

export function normalizeUrl(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|ref$|source$|campaign$)/i.test(key)) u.searchParams.delete(key);
    }
    u.pathname = u.pathname.replace(/\/$/, "") || "/";
    return u.toString();
  } catch {
    return String(raw).trim();
  }
}

export function projectId(candidate) {
  if (candidate.githubFullName) return `github:${candidate.githubFullName.toLowerCase()}`;
  const url = normalizeUrl(candidate.url || candidate.homepage || candidate.sourceUrl || "");
  try {
    const u = new URL(url);
    const path = u.pathname.split("/").filter(Boolean).slice(0, 2).join("/");
    return `web:${u.hostname.toLowerCase()}:${path.toLowerCase()}`;
  } catch {
    return `text:${crypto.createHash("sha1").update(`${candidate.name}|${candidate.source || ""}`).digest("hex").slice(0, 16)}`;
  }
}

export function dedupeCandidates(candidates) {
  const map = new Map();
  for (const raw of candidates) {
    const candidate = { ...raw, url: normalizeUrl(raw.url || raw.homepage || raw.sourceUrl || "") };
    candidate.projectId = projectId(candidate);
    const old = map.get(candidate.projectId);
    if (!old) {
      map.set(candidate.projectId, { ...candidate, sourceSignals: [candidate.source].filter(Boolean) });
      continue;
    }
    const merged = {
      ...old,
      ...candidate,
      title: old.title || candidate.title,
      name: old.name || candidate.name,
      description: [old.description, candidate.description].filter(Boolean).sort((a, b) => b.length - a.length)[0] || "",
      sourceSignals: [...new Set([...(old.sourceSignals || []), candidate.source].filter(Boolean))],
      discussionUrl: old.discussionUrl || candidate.discussionUrl,
      homepage: old.homepage || candidate.homepage,
      githubFullName: old.githubFullName || candidate.githubFullName,
      stars: Math.max(old.stars || 0, candidate.stars || 0),
      comments: Math.max(old.comments || 0, candidate.comments || 0)
    };
    map.set(candidate.projectId, merged);
  }
  return [...map.values()];
}

const MONEY_WORDS = /affiliate|commission|referral|bounty|creator|marketplace|paid|pricing|subscription|revenue|monetiz|sell|payment|payout|佣金|分佣|奖励|付费|订阅|市场|创作者/i;
const DEMAND_WORDS = /agent|automation|workflow|api|marketplace|creator|video|search|local|ai|data|productivity|sales|customer|devtool|开发|自动化|创作|视频|搜索|销售|客户/i;
const EASY_WORDS = /no.?code|low.?code|template|plugin|extension|creator|affiliate|marketplace|api|web|tool|无代码|模板|插件|创作者/i;

export function quickScore(candidate, now = new Date()) {
  const text = `${candidate.title || ""} ${candidate.name || ""} ${candidate.description || ""}`;
  const freshness = recencyScore(candidate.publishedAt || candidate.createdAt, now);
  const monetization = MONEY_WORDS.test(text) ? 18 : 8;
  const participation = EASY_WORDS.test(text) ? 12 : 8;
  const demand = DEMAND_WORDS.test(text) ? 12 : 7;
  const signalBonus = Math.min(15, Math.log10((candidate.stars || 0) + (candidate.points || 0) + (candidate.comments || 0) + 10) * 6);
  const sourceBonus = Math.min(10, (candidate.sourceSignals?.length || 1) * 4);
  return Math.round(clamp(freshness + monetization + participation + demand + signalBonus + sourceBonus, 0, 100));
}

export function statusScore(value) {
  const v = String(value || "unknown").toLowerCase();
  if (["supported", "yes", "confirmed", "available", "not_required", "not_applicable"].includes(v)) return 100;
  if (["conditional", "limited"].includes(v)) return 65;
  if (["unknown", "not_found", "unconfirmed"].includes(v)) return 35;
  if (["conflicting"].includes(v)) return 25;
  if (["unsupported", "no", "blocked", "failed"].includes(v)) return 0;
  return 35;
}

export function evidenceScore(facts = {}) {
  let score = 0;
  if (facts.launch_status === "confirmed") score += 15;
  if (!["unknown", "unconfirmed", undefined, null, ""].includes(facts.mainland_registration)) score += 15;
  if (!["unknown", "unconfirmed", undefined, null, ""].includes(facts.kyc_status)) score += 15;
  if (!["unknown", "unconfirmed", undefined, null, ""].includes(facts.payout_status)) score += 15;
  if (facts.first_money_loop_status === "confirmed") score += 15;
  if ((facts.recent_payout_cases || []).length > 0) score += 15;
  if (facts.risk_evidence_status && facts.risk_evidence_status !== "unknown") score += 10;
  return clamp(score);
}

export function payoutConfidenceScore(facts = {}) {
  const payout = statusScore(facts.payout_status);
  const mainland = statusScore(facts.mainland_payout);
  const cases = Math.min(100, (facts.recent_payout_cases || []).length * 35);
  return clamp(payout * 0.45 + mainland * 0.35 + cases * 0.20);
}

export function mainlandExecutionScore(facts = {}) {
  const reg = statusScore(facts.mainland_registration);
  const kyc = statusScore(facts.kyc_status);
  const payout = statusScore(facts.mainland_payout);
  return clamp(reg * 0.35 + kyc * 0.25 + payout * 0.40);
}

export function starsFromScore(score) {
  const n = score >= 90 ? 5 : score >= 75 ? 4 : score >= 55 ? 3 : score >= 30 ? 2 : 1;
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export function fireFromScore(score) {
  const n = Math.max(1, Math.min(5, Math.round(clamp(score) / 20)));
  return "🔥".repeat(n) + "☆".repeat(5 - n);
}

export function actionIndex({ opportunityScore, mainlandScore, payoutScore, urgencyScore, longTermScore, personalMatch = null }) {
  const dims = [
    [opportunityScore, 30],
    [mainlandScore, 20],
    [payoutScore, 10],
    [urgencyScore, 10],
    [longTermScore, 15]
  ];
  if (Number.isFinite(personalMatch)) dims.push([personalMatch, 15]);
  const totalWeight = dims.reduce((sum, [, w]) => sum + w, 0);
  return Math.round(dims.reduce((sum, [v, w]) => sum + clamp(v) * w, 0) / totalWeight);
}

export function hardLimitRecommendation({ facts, evidence, action }) {
  let maxStars = 5;
  let cappedAction = action;
  const registration = String(facts.mainland_registration || "unknown");
  const kyc = String(facts.kyc_status || "unknown");
  const payout = String(facts.mainland_payout || "unknown");
  if ([registration, kyc, payout].includes("unsupported")) {
    maxStars = 1;
    cappedAction = Math.min(cappedAction, 45);
  } else if ([registration, kyc, payout].some((v) => ["unknown", "unconfirmed", "conflicting"].includes(v))) {
    maxStars = Math.min(maxStars, 3);
  }
  if (evidence < 70) {
    maxStars = Math.min(maxStars, 3);
    cappedAction = Math.min(cappedAction, 74);
  }
  return { maxStars, actionIndex: Math.round(cappedAction) };
}

export function lifecycle(candidate, now = new Date()) {
  const days = daysAgo(candidate.publishedAt || candidate.createdAt, now);
  const heat = (candidate.stars || 0) + (candidate.points || 0) + (candidate.comments || 0) * 2;
  if (days <= 3 && heat < 200) return "🟢 S0 刚出现";
  if (days <= 14 && heat < 1000) return "🟢 S1 早期验证";
  if (days <= 45 && heat < 5000) return "🟡 S2 起量";
  if (heat < 20000) return "🟠 S3 拥挤";
  return "🔴 S4 成熟/过热";
}

export function confidenceLabel(evidence) {
  return evidence >= 85 ? "高" : evidence >= 60 ? "中" : "低";
}

export function actionLabel(score, evidence) {
  if (evidence < 50) return "仅观察";
  if (score >= 90 && evidence >= 70) return "今天就测";
  if (score >= 75 && evidence >= 70) return "本周测试";
  if (score >= 60) return "观察/小测";
  return "跳过";
}

export function evidenceLabel(score) {
  if (score >= 85) return "充分";
  if (score >= 70) return "较完整";
  if (score >= 50) return "一般";
  return "不足";
}

export function mainlandLabel(facts) {
  const reg = facts.mainland_registration;
  const kyc = facts.kyc_status;
  const payout = facts.mainland_payout;
  if ([reg, kyc, payout].includes("unsupported")) return "❌ 不适合";
  if ([reg, kyc, payout].some((v) => ["unknown", "unconfirmed", "conflicting", undefined, null].includes(v))) return "❓ 未确认";
  if ([reg, kyc, payout].includes("conditional")) return "🟡 有条件参考";
  return "✅ 可直接参考";
}

export function detectChanges(previous, current) {
  if (!previous) return [];
  const changes = [];
  const pairs = [
    ["大陆注册", previous.facts?.mainland_registration, current.facts?.mainland_registration],
    ["KYC", previous.facts?.kyc_status, current.facts?.kyc_status],
    ["大陆收款", previous.facts?.mainland_payout, current.facts?.mainland_payout],
    ["提现规则", previous.facts?.payout_status, current.facts?.payout_status]
  ];
  for (const [label, from, to] of pairs) {
    if (from && to && from !== to) changes.push(`${label}：${from} → ${to}`);
  }
  const oldCases = previous.facts?.recent_payout_cases?.length || 0;
  const newCases = current.facts?.recent_payout_cases?.length || 0;
  if (newCases > oldCases) changes.push(`新增真实到账案例：${oldCases} → ${newCases}`);
  if (Number.isFinite(previous.actionIndex) && current.actionIndex - previous.actionIndex >= 8) {
    changes.push(`行动指数：${previous.actionIndex} → ${current.actionIndex}`);
  }
  return changes;
}
