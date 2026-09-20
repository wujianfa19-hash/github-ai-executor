import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionIndex,
  dedupeCandidates,
  detectChanges,
  evidenceScore,
  hardLimitRecommendation,
  lifecycle,
  mainlandExecutionScore,
  mainlandLabel,
  payoutConfidenceScore,
  quickScore
} from "./src/core.mjs";
import {
  analyzeWithDeepSeek,
  collectBraveSearch,
  collectGitHub,
  collectHackerNews,
  fetchEvidencePages,
  sendGmail
} from "./src/services.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const SKILL_PATH = path.join(__dirname, "SKILL_RUNTIME.md");
const DATA_DIR = process.env.DATA_DIR || process.env.STATE_DIR || path.join(__dirname, "data");
const REPORT_DIR = process.env.REPORT_DIR || path.join(__dirname, "reports");
const STATE_PATH = path.join(DATA_DIR, "state.json");

const dryRun = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const now = new Date();
const dateCN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(now);

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function loadConfig() {
  const cfg = await loadJson(CONFIG_PATH, null);
  if (!cfg) throw new Error("配置文件 config.json 缺失或格式错误");
  return cfg;
}

async function loadState() {
  return loadJson(STATE_PATH, { schemaVersion: 1, projects: {}, runs: [] });
}

function cnValue(value) {
  if (value === null || value === undefined || value === "") return "未确认";
  const raw = String(value).trim();
  const key = raw.toLowerCase();
  const map = {
    unknown: "未确认",
    unconfirmed: "未确认",
    confirmed: "已确认",
    supported: "支持",
    conditional: "有条件支持",
    unsupported: "不支持",
    conflicting: "信息冲突",
    not_required: "不需要",
    not_applicable: "不适用",
    none_found: "暂未发现",
    yes: "是",
    no: "否",
    true: "是",
    false: "否",
    available: "可用",
    unavailable: "不可用",
    allowed: "允许",
    blocked: "受限",
    required: "需要",
    optional: "可选"
  };
  return map[key] || raw;
}

function recommendationText(record) {
  if (record.belowThresholdFallback) return "观察";
  if (record.actionIndex >= 75 && record.evidenceScore >= 70) return "值得行动";
  if (record.actionIndex >= 60) return "可小试";
  return "观察";
}

function fallbackAnalysis(candidate) {
  const q = quickScore(candidate, now);
  return {
    summary: candidate.description || "发现一个近期出现的项目线索，但当前证据不足，建议先观察。",
    why_now: `首次信号来自 ${candidate.sourceSignals?.join(" / ") || candidate.source || "公开来源"}，仍需要进一步核验。`,
    monetization_paths: [],
    monetization_type: "D",
    first_money_loop: "尚未验证",
    first_money_loop_status: "unconfirmed",
    seven_day_test: [
      "阅读官方规则，确认项目解决什么问题",
      "确认中国大陆注册、实名认证和结算是否可行",
      "不付费、不投广告，先做一次最小验证",
      "7天内拿不到真实询盘、订单或收益信号就停止"
    ],
    thresholds: { funding: "低", skills: "未知", geo_account: "未知", existing_traffic: "未知" },
    facts: {
      launch_status: candidate.publishedAt ? "confirmed" : "unconfirmed",
      mainland_registration: "unknown",
      kyc_status: "unknown",
      mainland_mobile: "unknown",
      payout_status: "unknown",
      mainland_payout: "unknown",
      payout_methods: [],
      settlement_details: "未确认",
      tax_company_requirements: "未确认",
      recent_payout_cases: [],
      risk_evidence_status: "unknown",
      risks: ["自动化暂未找到足够的官方资格与结算证据"]
    },
    scores: {
      opportunity_score: q,
      urgency_score: 40,
      long_term_score: 50
    },
    long_term_reason: "证据不足，暂时无法判断能否形成长期资产。",
    today_action: "只做官方规则核验，不投入资金。",
    confidence_notes: "人工智能分析未启用或调用失败，当前使用保守规则结果。",
    source_urls: [candidate.url, candidate.discussionUrl].filter(Boolean)
  };
}

function buildRecord(candidate, analysis, evidence) {
  const facts = { ...(analysis.facts || {}) };
  const eScore = evidenceScore({ ...facts, first_money_loop_status: analysis.first_money_loop_status });
  const mainland = mainlandExecutionScore(facts);
  const payout = payoutConfidenceScore(facts);
  const opp = Math.round(Math.max(0, Math.min(100, analysis.scores?.opportunity_score ?? quickScore(candidate, now))));
  const urgency = Math.round(Math.max(0, Math.min(100, analysis.scores?.urgency_score ?? 40)));
  const longTerm = Math.round(Math.max(0, Math.min(100, analysis.scores?.long_term_score ?? 50)));
  let aIndex = actionIndex({ opportunityScore: opp, mainlandScore: mainland, payoutScore: payout, urgencyScore: urgency, longTermScore: longTerm });
  const hard = hardLimitRecommendation({ facts, evidence: eScore, action: aIndex });
  aIndex = hard.actionIndex;
  const stars = Math.min(hard.maxStars, aIndex >= 90 ? 5 : aIndex >= 75 ? 4 : aIndex >= 55 ? 3 : aIndex >= 30 ? 2 : 1);
  return {
    projectId: candidate.projectId,
    name: candidate.name || candidate.title,
    url: candidate.url,
    homepage: candidate.homepage || "",
    discussionUrl: candidate.discussionUrl || "",
    sourceSignals: candidate.sourceSignals || [candidate.source].filter(Boolean),
    publishedAt: candidate.publishedAt || null,
    firstSeenAt: dateCN,
    lastCheckedAt: dateCN,
    lifecycle: lifecycle(candidate, now),
    opportunityScore: opp,
    evidenceScore: eScore,
    mainlandScore: Math.round(mainland),
    payoutScore: Math.round(payout),
    urgencyScore: urgency,
    longTermScore: longTerm,
    actionIndex: aIndex,
    recommendationStars: "★".repeat(stars) + "☆".repeat(5 - stars),
    facts,
    analysis,
    evidenceSources: evidence.sources.map(({ kind, url, official }) => ({ kind, url, official })),
    evidenceErrors: evidence.errors || [],
    belowThresholdFallback: false,
    selectionNote: ""
  };
}

function rankRecords(records) {
  return [...records].sort((a, b) =>
    (b.actionIndex * 0.65 + b.evidenceScore * 0.35) -
    (a.actionIndex * 0.65 + a.evidenceScore * 0.35)
  );
}

function selectFinalRecords(records, config) {
  const ranked = rankRecords(records);
  const passed = ranked
    .filter((r) => r.opportunityScore >= config.thresholds.min_opportunity_score_final)
    .filter((r) => r.actionIndex >= config.thresholds.min_action_index_final)
    .slice(0, config.scan.max_final_recommendations);

  const minimum = Math.max(1, config.scan.min_daily_recommendations ?? 1);
  if (passed.length >= minimum || !ranked.length) return passed;

  const selected = [...passed];
  for (const record of ranked) {
    if (selected.some((x) => x.projectId === record.projectId)) continue;
    record.belowThresholdFallback = true;
    record.selectionNote = `本项目未达到正式推荐门槛（正式门槛：机会评分≥${config.thresholds.min_opportunity_score_final}，行动指数≥${config.thresholds.min_action_index_final}），但按“每日最低至少展示1条”的规则，作为今天相对最值得观察的候选展示。它不是强推荐，建议只做低成本核验。`;
    selected.push(record);
    if (selected.length >= minimum) break;
  }
  return selected.slice(0, config.scan.max_final_recommendations);
}

function projectMarkdown(record, idx) {
  const a = record.analysis || {};
  const f = record.facts || {};
  const lines = [`## ${idx}. ${record.name}`, ""];

  lines.push("### 【结论】");
  lines.push(`- 推荐级别：**${recommendationText(record)}**`);
  lines.push(`- 行动指数：**${record.actionIndex}/100**`);
  lines.push(`- 证据完整度：**${record.evidenceScore}/100**`);
  lines.push(`- 阶段：${cnValue(record.lifecycle)}`);
  if (record.belowThresholdFallback) {
    lines.push(`- 备注：${record.selectionNote}`);
  }
  lines.push("");

  lines.push("### 【项目与机会】");
  lines.push(`**它是什么：** ${a.summary || "未确认"}`);
  lines.push(`**为什么现在值得看：** ${a.why_now || "尚无足够证据。"}`);
  lines.push("");

  lines.push("### 【怎么赚钱】");
  const money = a.monetization_paths || [];
  if (money.length) {
    money.slice(0, 3).forEach((x) => lines.push(`- ${x}`));
  } else {
    lines.push("- 暂未验证明确变现路径。 ");
  }
  lines.push(`- **第一笔钱闭环：** ${a.first_money_loop || "尚未验证"}`);
  lines.push("");

  lines.push("### 【大陆用户能不能做】");
  lines.push(`- 注册：${cnValue(f.mainland_registration)}`);
  lines.push(`- 实名认证：中国大陆身份证 ${cnValue(f.kyc_status)}`);
  lines.push(`- 收款提现：${(f.payout_methods || []).map(cnValue).join(" / ") || "未确认"}${f.settlement_details && f.settlement_details !== "未确认" ? `；${cnValue(f.settlement_details)}` : ""}`);
  lines.push(`- 大陆到账：${cnValue(f.mainland_payout)}`);
  lines.push(`- 近期真实到账案例：${(f.recent_payout_cases || []).length ? `找到 ${f.recent_payout_cases.length} 条待核验或已核验案例` : "暂未找到近期大陆真实到账案例"}`);
  lines.push(`- **结论：${mainlandLabel(f)}**`);
  lines.push("");

  lines.push("### 【风险与未确认】");
  const risks = f.risks || [];
  if (risks.length) risks.slice(0, 4).forEach((x) => lines.push(`- ${x}`));
  else lines.push("- 暂未发现明确重大风险，但不代表没有风险。 ");
  if (record.evidenceErrors.length) lines.push(`- 数据源异常：${record.evidenceErrors.slice(0, 2).join("；")}`);
  lines.push("");

  lines.push("### 【行动方案】");
  lines.push(`- **今天：** ${a.today_action || "只核验官方规则，不投入资金。"}`);
  const steps = (a.seven_day_test || []).slice(0, 4);
  if (steps.length) {
    lines.push("- **7天验证：**");
    steps.forEach((x, i) => lines.push(`  ${i + 1}. ${x}`));
  } else {
    lines.push("- **7天验证：** 先补齐官方规则证据，再设计低成本验证。 ");
  }
  lines.push("");

  lines.push("### 【证据】");
  const src = [...new Set([
    record.url,
    record.homepage,
    record.discussionUrl,
    ...(a.source_urls || []),
    ...record.evidenceSources.map((s) => s.url)
  ].filter(Boolean))];
  lines.push(src.slice(0, 5).map((u) => `- ${u}`).join("\n") || "- 暂无可引用来源");
  lines.push("");
  return lines.join("\n");
}

function buildDailyReport(records, stats, sourceErrors) {
  const lines = [`# 今日网创新项目雷达｜${dateCN}`, ""];
  if (!records.length) {
    lines.push("今天未获取到可深度核验的有效线索，因此没有人为编造项目。请检查数据源是否异常。", "");
  } else {
    const fallbackCount = records.filter((r) => r.belowThresholdFallback).length;
    if (fallbackCount) {
      lines.push(`**说明：今天没有足够项目达到正式推荐门槛，因此按最低输出规则展示 ${fallbackCount} 条相对最值得观察的候选。**`, "");
    }
    records.forEach((r, i) => lines.push(projectMarkdown(r, i + 1)));
  }

  lines.push("## 今日总结", "");
  if (records.length) {
    const byAction = [...records].sort((a, b) => b.actionIndex - a.actionIndex)[0];
    lines.push(`**今天优先看：** ${byAction.name}｜${recommendationText(byAction)}｜行动指数 ${byAction.actionIndex}/100`);
  } else {
    lines.push("**今天优先看：** 无有效候选");
  }
  lines.push(`**今日扫描：** ${stats.raw} 条 → ${stats.quick} 条候选 → ${stats.deep} 条深度核验 → 展示 ${records.length} 条`);
  if (sourceErrors.length) {
    lines.push(`**数据源异常：** ${sourceErrors.slice(0, 3).map((e) => `${e.sourceName || "数据源"}：${e.error || "未知错误"}`).join("；")}`);
  }
  return lines.join("\n");
}

function buildAlertReport(alerts) {
  const lines = [`# 网创新机会变化提醒 · ${dateCN}`, ""];
  for (const alert of alerts) {
    lines.push(`## ${alert.record.name}`, "");
    alert.changes.forEach((c) => lines.push(`- ${c}`));
    lines.push(`- 当前行动指数：${alert.record.actionIndex}/100`);
    lines.push(`- 当前证据完整度：${alert.record.evidenceScore}/100`);
    lines.push(`- 地址：${alert.record.url}`, "");
  }
  lines.push("提醒只表示事实条件发生变化，不代表保证收益。先做低成本验证。" );
  return lines.join("\n");
}

async function run() {
  const config = await loadConfig();
  const state = await loadState();
  const baseSkill = await fs.readFile(SKILL_PATH, "utf8");
  const skill = `${baseSkill}\n\n强制语言规则：所有分析、说明、风险、行动建议必须使用简体中文。项目名称、品牌名、网址和必要技术名词可以保留原文。不得用 unknown、confirmed、unconfirmed 等英文状态词作为面向用户的输出。`;
  const maxLookback = Math.max(...config.scan.lookback_hours);
  const sourceErrors = [];

  const [gh, hn, brave] = await Promise.all([
    config.sources.github ? collectGitHub({ token: process.env.GITHUB_TOKEN, queries: config.scan.github_queries, lookbackHours: maxLookback, max: Math.ceil(config.scan.max_raw_leads / 2) }) : [],
    config.sources.hacker_news ? collectHackerNews({ queries: config.scan.hn_queries, lookbackHours: maxLookback, max: Math.ceil(config.scan.max_raw_leads / 2) }) : [],
    config.sources.brave_search_optional ? collectBraveSearch({ apiKey: process.env.BRAVE_SEARCH_API_KEY, queries: ["新创作者变现平台", "新联盟营销项目", "新人工智能交易平台"], max: 20 }) : []
  ]);

  const raw = [...gh, ...hn, ...brave];
  for (const x of raw.filter((x) => x.source === "source_error")) sourceErrors.push(x);
  const valid = raw.filter((x) => x.source !== "source_error" && x.url).slice(0, config.scan.max_raw_leads);
  const deduped = dedupeCandidates(valid);
  for (const c of deduped) c.quickScore = quickScore(c, now);
  const rankedQuickPool = [...deduped].sort((a, b) => b.quickScore - a.quickScore);
  const quick = rankedQuickPool
    .filter((c) => c.quickScore >= config.thresholds.min_opportunity_score_quick)
    .slice(0, config.scan.max_quick_candidates);
  const deepCandidates = (quick.length ? quick : rankedQuickPool.slice(0, 1)).slice(0, config.scan.max_deep_verify);

  const records = [];
  for (const candidate of deepCandidates) {
    const evidence = await fetchEvidencePages(candidate, {
      githubToken: process.env.GITHUB_TOKEN,
      braveApiKey: process.env.BRAVE_SEARCH_API_KEY,
      maxPages: 5
    });
    let analysis;
    try {
      analysis = await analyzeWithDeepSeek(candidate, evidence, {
        apiKey: process.env.DEEPSEEK_KEY,
        model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
        skillExcerpt: skill
      });
    } catch (error) {
      evidence.errors.push(`人工智能分析：${error.message || error}`);
    }
    if (!analysis) analysis = fallbackAnalysis(candidate);
    const record = buildRecord(candidate, analysis, evidence);
    const previous = state.projects?.[record.projectId];
    if (previous?.firstSeenAt) record.firstSeenAt = previous.firstSeenAt;
    record.changes = detectChanges(previous, record);
    records.push(record);
  }

  const final = selectFinalRecords(records, config);
  const stats = { raw: valid.length, deduped: deduped.length, quick: quick.length, deep: records.length };
  const report = buildDailyReport(final, stats, sourceErrors);
  const alerts = records.filter((r) => (r.changes || []).length).map((record) => ({ record, changes: record.changes }));
  const alertReport = alerts.length ? buildAlertReport(alerts) : "";

  const outputDir = dryRun ? path.join(os.tmpdir(), "net-venture-radar-dryrun") : REPORT_DIR;
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `net-venture-radar-${dateCN}.md`);
  await fs.writeFile(reportPath, report, "utf8");
  if (alertReport) await fs.writeFile(path.join(outputDir, `net-venture-radar-alerts-${dateCN}.md`), alertReport, "utf8");

  if (!dryRun) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const nextProjects = { ...(state.projects || {}) };
    for (const record of records) nextProjects[record.projectId] = record;
    const entries = Object.entries(nextProjects)
      .sort(([, a], [, b]) => String(b.lastCheckedAt || "").localeCompare(String(a.lastCheckedAt || "")))
      .slice(0, 500);
    const nextState = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      projects: Object.fromEntries(entries),
      runs: [
        ...(state.runs || []).filter((r) => Date.parse(r.startedAt || 0) >= Date.now() - 180 * 86_400_000),
        { date: dateCN, startedAt: now.toISOString(), stats, finalProjectIds: final.map((r) => r.projectId), sourceErrors: sourceErrors.slice(0, 20) }
      ].slice(-180)
    };
    await fs.writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }

  const gmailReady = [process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REFRESH_TOKEN, process.env.REPORT_RECIPIENT_EMAIL].every(Boolean);
  if (!dryRun && gmailReady && config.notifications.daily_report) {
    const to = process.env.REPORT_RECIPIENT_EMAIL;
    await sendGmail({
      markdown: report,
      subject: `网创新项目雷达｜${dateCN}`,
      from: process.env.GMAIL_SENDER_EMAIL || to,
      to,
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN
    });
    if (alertReport && config.notifications.upgrade_downgrade_alerts) {
      await sendGmail({
        markdown: alertReport,
        subject: `网创新机会变化提醒｜${dateCN}`,
        from: process.env.GMAIL_SENDER_EMAIL || to,
        to,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    reportPath,
    stats,
    displayed: final.map((r) => ({ name: r.name, actionIndex: r.actionIndex, evidenceScore: r.evidenceScore, belowThresholdFallback: r.belowThresholdFallback })),
    alerts: alerts.length
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { buildDailyReport, buildRecord, cnValue, fallbackAnalysis, projectMarkdown, recommendationText, selectFinalRecords };