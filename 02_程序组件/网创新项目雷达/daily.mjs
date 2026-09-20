import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  actionIndex,
  actionLabel,
  confidenceLabel,
  dedupeCandidates,
  detectChanges,
  evidenceLabel,
  evidenceScore,
  fireFromScore,
  hardLimitRecommendation,
  lifecycle,
  mainlandExecutionScore,
  mainlandLabel,
  payoutConfidenceScore,
  quickScore,
  starsFromScore
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
const dateCN = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
}

async function loadConfig() {
  const cfg = await loadJson(CONFIG_PATH, null);
  if (!cfg) throw new Error("config.json missing or invalid");
  return cfg;
}

async function loadState() {
  return loadJson(STATE_PATH, { schemaVersion: 1, projects: {}, runs: [] });
}

function fallbackAnalysis(candidate) {
  const q = quickScore(candidate, now);
  return {
    summary: candidate.description || "发现一个近期出现的项目线索，但当前证据不足，建议仅观察。",
    why_now: `首次信号来自 ${candidate.sourceSignals?.join(" / ") || candidate.source || "公开来源"}，需要进一步核验。`,
    monetization_paths: [],
    monetization_type: "D",
    first_money_loop: "尚未验证",
    first_money_loop_status: "unconfirmed",
    seven_day_test: ["阅读官方规则并确认项目解决什么问题", "确认中国大陆注册/KYC/结算是否可行", "不付费、不投广告，做一次最小产品或服务验证", "7天内拿不到真实询盘/订单/收益信号则停止"],
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
      risks: ["自动化未找到足够官方资格与结算证据"]
    },
    scores: {
      freshness: Math.min(30, q * 0.3),
      monetization_clarity: 6,
      participation: 8,
      demand_bonus: 8,
      information_gap: 10,
      opportunity_score: q,
      urgency_score: 40,
      long_term_score: 50
    },
    long_term_reason: "证据不足，暂时无法判断能否形成长期资产。",
    today_action: "只做官方规则核验，不投入资金。",
    confidence_notes: "DeepSeek 未启用或分析失败，当前为保守规则回退结果。",
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
  const computedStars = Math.min(hard.maxStars, aIndex >= 90 ? 5 : aIndex >= 75 ? 4 : aIndex >= 55 ? 3 : aIndex >= 30 ? 2 : 1);
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
    recommendationStars: "★".repeat(computedStars) + "☆".repeat(5 - computedStars),
    facts,
    analysis,
    evidenceSources: evidence.sources.map(({ kind, url, official }) => ({ kind, url, official })),
    evidenceErrors: evidence.errors || []
  };
}

function projectMarkdown(record, idx) {
  const a = record.analysis;
  const f = record.facts;
  const lines = [];
  lines.push(`## ${idx}. ${record.name}`);
  lines.push("");
  lines.push(`**状态：${record.lifecycle}**  `);
  lines.push(`**机会评分：${record.opportunityScore}/100**  `);
  lines.push(`**行动指数：${record.actionIndex}/100（${actionLabel(record.actionIndex, record.evidenceScore)}）**  `);
  lines.push(`**大陆用户推荐：${record.recommendationStars}**  `);
  lines.push(`**大陆可执行性：${mainlandLabel(f)}**  `);
  lines.push(`**真实到账置信度：${starsFromScore(record.payoutScore)}**  `);
  lines.push(`**证据完整度：${record.evidenceScore}/100（${evidenceLabel(record.evidenceScore)}）**  `);
  lines.push(`**窗口紧迫度：${fireFromScore(record.urgencyScore)}**  `);
  lines.push(`**长期投入价值：${starsFromScore(record.longTermScore)}**  `);
  lines.push(`**个人匹配度：未个性化**  `);
  lines.push(`**首次发现：${record.firstSeenAt}**  `);
  lines.push(`**最近核验：${record.lastCheckedAt}**  `);
  lines.push(`**置信度：${confidenceLabel(record.evidenceScore)}**`);
  lines.push("");
  lines.push("### 项目是什么");
  lines.push(a.summary || "未确认");
  lines.push("");
  lines.push("### 为什么现在可能有机会");
  lines.push(a.why_now || "尚无足够证据。");
  lines.push("");
  lines.push("### 可以怎么赚钱");
  const money = a.monetization_paths || [];
  lines.push(money.length ? money.map((x) => `- ${x}`).join("\n") : "- 平台本身暂未验证直接付钱；暂无足够证据给出确定变现路径。\n");
  lines.push("");
  lines.push("### 首钱闭环");
  lines.push(a.first_money_loop || "尚未验证");
  lines.push("");
  lines.push("### 变现类型");
  lines.push(`${a.monetization_type || "D"}（A官方直接付钱 / B平台内交易分佣 / C生态获客后间接变现 / D尚无明确变现）`);
  lines.push("");
  lines.push("### 7 天第一笔钱验证");
  lines.push((a.seven_day_test || []).map((x, i) => `${i + 1}. ${x}`).join("\n") || "尚无法设计可靠首钱验证，先补齐官方规则证据。");
  lines.push("");
  lines.push("### 普通人参与门槛");
  lines.push(`- 资金：${a.thresholds?.funding || "未知"}`);
  lines.push(`- 技能：${a.thresholds?.skills || "未知"}`);
  lines.push(`- 地域 / 账号限制：${a.thresholds?.geo_account || "未知"}`);
  lines.push(`- 是否需要已有流量：${a.thresholds?.existing_traffic || "未知"}`);
  lines.push("");
  lines.push("### 中国大陆用户适配");
  lines.push(`- 中国大陆用户能否注册：${f.mainland_registration || "unknown"}`);
  lines.push(`- 大陆身份证 KYC：${f.kyc_status || "unknown"}`);
  lines.push(`- 大陆手机号：${f.mainland_mobile || "unknown"}`);
  lines.push(`- 提现方式：${(f.payout_methods || []).join(" / ") || "未确认"}`);
  lines.push(`- 能否提现至大陆用户可用账户：${f.mainland_payout || "unknown"}`);
  lines.push(`- 最低提现 / 结算周期 / 币种：${f.settlement_details || "未确认"}`);
  lines.push(`- 税务 / 公司主体要求：${f.tax_company_requirements || "未确认"}`);
  lines.push(`- 近期大陆真实到账案例：${(f.recent_payout_cases || []).length ? `发现 ${f.recent_payout_cases.length} 条待/已核验案例` : "未发现近期大陆真实到账案例"}`);
  lines.push(`- **结论：${mainlandLabel(f)}**`);
  lines.push("");
  lines.push("### 是否值得长期投入");
  lines.push(`${starsFromScore(record.longTermScore)}：${a.long_term_reason || "证据不足。"}`);
  lines.push("");
  lines.push("### 今天最值得做的一步");
  lines.push(a.today_action || "只核验官方规则，不投入资金。");
  lines.push("");
  lines.push("### 风险 / 尚未确认");
  lines.push((f.risks || []).length ? (f.risks || []).map((x) => `- ${x}`).join("\n") : "- 暂未发现明确风险，但不代表无风险。\n");
  if (record.evidenceErrors.length) lines.push(`- 数据源失败：${record.evidenceErrors.slice(0, 3).join("；")}`);
  lines.push("");
  lines.push("### 来源");
  const src = [...new Set([record.url, record.homepage, record.discussionUrl, ...(a.source_urls || []), ...record.evidenceSources.map((s) => s.url)].filter(Boolean))];
  lines.push(src.slice(0, 8).map((u) => `- ${u}`).join("\n") || "- 无可引用来源");
  lines.push("");
  return lines.join("\n");
}

function buildDailyReport(records, stats, sourceErrors) {
  const lines = [`# 今日新项目雷达 · ${dateCN}`, ""];
  if (!records.length) {
    lines.push("今天没有达到推荐门槛的高质量新项目。系统按规则正常结束，没有为了凑数推荐。", "");
  } else {
    records.forEach((r, i) => lines.push(projectMarkdown(r, i + 1)));
  }
  lines.push("## 今日结论", "");
  if (records.length) {
    const byAction = [...records].sort((a, b) => b.actionIndex - a.actionIndex)[0];
    const byLong = [...records].sort((a, b) => b.longTermScore - a.longTermScore)[0];
    lines.push(`**行动指数最高：** ${byAction.name}（${byAction.actionIndex}/100）`);
    lines.push(`**最值得长期投入：** ${byLong.name}（${starsFromScore(byLong.longTermScore)}）`);
  } else {
    lines.push("**行动指数最高：** 无达到门槛的项目");
  }
  lines.push("", "**扫描统计：**");
  lines.push(`- 扫描线索：${stats.raw}`);
  lines.push(`- 去重后：${stats.deduped}`);
  lines.push(`- 快速候选：${stats.quick}`);
  lines.push(`- 深度验证：${stats.deep}`);
  lines.push(`- 最终推荐：${records.length}`);
  if (sourceErrors.length) {
    lines.push("", "**数据源异常（未拖垮主流程）：**");
    sourceErrors.slice(0, 8).forEach((e) => lines.push(`- ${e.sourceName}: ${e.error}`));
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
  lines.push("提醒只表示事实条件发生变化，不等于保证收益。先做低成本验证。" );
  return lines.join("\n");
}

async function run() {
  const config = await loadConfig();
  const state = await loadState();
  const skill = await fs.readFile(SKILL_PATH, "utf8");
  const maxLookback = Math.max(...config.scan.lookback_hours);
  const sourceErrors = [];

  const [gh, hn, brave] = await Promise.all([
    config.sources.github ? collectGitHub({ token: process.env.GITHUB_TOKEN, queries: config.scan.github_queries, lookbackHours: maxLookback, max: Math.ceil(config.scan.max_raw_leads / 2) }) : [],
    config.sources.hacker_news ? collectHackerNews({ queries: config.scan.hn_queries, lookbackHours: maxLookback, max: Math.ceil(config.scan.max_raw_leads / 2) }) : [],
    config.sources.brave_search_optional ? collectBraveSearch({ apiKey: process.env.BRAVE_SEARCH_API_KEY, queries: ["new creator monetization platform", "new affiliate program launch", "new AI marketplace launch"], max: 20 }) : []
  ]);

  const raw = [...gh, ...hn, ...brave];
  for (const x of raw.filter((x) => x.source === "source_error")) sourceErrors.push(x);
  const valid = raw.filter((x) => x.source !== "source_error" && x.url).slice(0, config.scan.max_raw_leads);
  const deduped = dedupeCandidates(valid);
  for (const c of deduped) c.quickScore = quickScore(c, now);
  const quick = deduped
    .filter((c) => c.quickScore >= config.thresholds.min_opportunity_score_quick)
    .sort((a, b) => b.quickScore - a.quickScore)
    .slice(0, config.scan.max_quick_candidates);
  const deepCandidates = quick.slice(0, config.scan.max_deep_verify);

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
      evidence.errors.push(`DeepSeek: ${error.message || error}`);
    }
    if (!analysis) analysis = fallbackAnalysis(candidate);
    const record = buildRecord(candidate, analysis, evidence);
    const previous = state.projects?.[record.projectId];
    if (previous?.firstSeenAt) record.firstSeenAt = previous.firstSeenAt;
    record.changes = detectChanges(previous, record);
    records.push(record);
  }

  const final = records
    .filter((r) => r.opportunityScore >= config.thresholds.min_opportunity_score_final)
    .filter((r) => r.actionIndex >= config.thresholds.min_action_index_final)
    .sort((a, b) => (b.actionIndex * 0.65 + b.evidenceScore * 0.35) - (a.actionIndex * 0.65 + a.evidenceScore * 0.35))
    .slice(0, config.scan.max_final_recommendations);

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

  console.log(JSON.stringify({ ok: true, dryRun, reportPath, stats, final: final.map((r) => ({ name: r.name, actionIndex: r.actionIndex, evidenceScore: r.evidenceScore })), alerts: alerts.length }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { buildDailyReport, buildRecord, fallbackAnalysis, projectMarkdown };
