import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentEligibility,
  dedupeByUrl,
  diffModels,
  freeLevelFromEvidence,
  recommendationForAgent,
  replacementDecision,
  scoreAgent
} from "./src/core.mjs";
import {
  collectBraveFreeAi,
  collectGitHubLeads,
  collectHackerNews,
  enrichAgentRepos,
  fetchProviderModels,
  fetchWatchEvidence,
  probeProviderModel,
  sendGmail
} from "./src/services.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const REGISTRY_PATH = path.join(__dirname, "..", "共享", "free-model-registry.json");
const DATA_DIR = process.env.DATA_DIR || process.env.STATE_DIR || path.join(__dirname, "data");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const REPORT_DIR = process.env.REPORT_DIR || path.join(__dirname, "reports");
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

function currentStateDefault() {
  return { schemaVersion: 1, providers: {}, watchOnly: {}, seenLeadUrls: [], seenAgentUrls: [], runs: [] };
}

function changedHashes(previous = [], current = []) {
  if (!previous.length) return false;
  if (previous.length !== current.length) return true;
  return previous.some((x, i) => x !== current[i]);
}

function providerLine(result) {
  let health;
  if (result.probe.ok && result.probe.jsonOk) health = `正常（${result.probe.latencyMs ?? "?"}ms，JSON测试通过）`;
  else if (result.probe.ok) health = `可用（${result.probe.latencyMs ?? "?"}ms，返回格式未完全命中测试模板）`;
  else health = `暂时异常：${result.probe.status}`;
  const models = result.models.ok ? `${result.models.ids.length} 个可见模型` : `模型列表未取到：${result.models.status}`;
  return `- **${result.provider.displayName || result.provider.name}**：当前 ${result.provider.model}；调用${health}；${models}`;
}

function buildReport({ providerResults, watchOnlyResults, apiLeads, agents, sourceErrors }) {
  const lines = [`# 免费 AI 资源雷达｜${dateCN}`, ""];
  const changedProviders = providerResults.filter((r) => r.diff.added.length || r.diff.removed.length || r.watchChanged || !r.probe.ok);
  const verifiedNewModels = providerResults.flatMap((r) => r.newCandidates.filter((c) => c.freeLevel === "A" && c.probeOk).map((c) => ({ provider: r.provider, ...c })));

  lines.push("## 【今日结论】", "");
  lines.push(`- 已检查 ${providerResults.length} 家生产供应商，发现 ${changedProviders.length} 家有模型、页面或临时健康状态变化。`);
  lines.push(`- 新出现且同时具备 A 级免费证据、最小调用成功的模型：${verifiedNewModels.length} 个。`);
  lines.push(`- 新的免费 API 公开线索：${apiLeads.length} 条；这些线索在官方免费证据核验前**不会进入生产路由**。`);
  lines.push(`- 符合“确认为 Agent 软件 + 软件免费 + 有免费大模型路径”的新 Agent：${agents.length} 个。`, "");

  lines.push("## 【现有供应商变化】", "");
  for (const result of providerResults) {
    lines.push(providerLine(result));
    if (result.diff.added.length) lines.push(`  - 新出现模型：${result.diff.added.slice(0, 8).join("、")}`);
    if (result.diff.removed.length) lines.push(`  - 消失模型：${result.diff.removed.slice(0, 8).join("、")}`);
    if (result.watchChanged) lines.push("  - 官方监控页面内容发生变化，需要继续核对免费额度、下线或定价规则。");
    lines.push(`  - 替换建议：**${result.decision.level}**；${result.decision.recommendation}`);
    for (const candidate of result.newCandidates.slice(0, 4)) {
      lines.push(`  - 候选 ${candidate.model}：免费级别 ${candidate.freeLevel}；最小调用 ${candidate.probeOk ? "成功" : candidate.probeStatus}；${candidate.freeReason}`);
    }
  }
  for (const item of watchOnlyResults) {
    lines.push(`- **${item.entry.displayName}**：仅监控，不进入生产路由；页面${item.changed ? "发生变化" : "暂无确认变化"}。`);
  }
  lines.push("");

  lines.push("## 【新发现免费 API 线索】", "");
  if (!apiLeads.length) {
    lines.push("- 今天没有新的公开线索。", "");
  } else {
    for (const lead of apiLeads.slice(0, 8)) {
      lines.push(`### ${lead.title || lead.name}`);
      lines.push("- 免费级别：**未确认**");
      lines.push("- 当前判断：只是近期公开线索，必须再找到官方价格/免费额度证据并完成真实 API 调用，才允许进入候选模型池。");
      lines.push(`- 来源：${lead.url}`);
      if (lead.discussionUrl && lead.discussionUrl !== lead.url) lines.push(`- 讨论：${lead.discussionUrl}`);
      lines.push("");
    }
  }

  lines.push("## 【最佳免费模型变化】", "");
  if (!verifiedNewModels.length) {
    lines.push("- 今天没有发现足够证据支持替换当前最佳免费模型。", "");
  } else {
    for (const item of verifiedNewModels) {
      lines.push(`- ${item.provider.displayName}：发现 ${item.model}，A 级免费证据且最小调用成功；**先观察，不自动替换**。`);
    }
    lines.push("");
  }

  lines.push("## 【新发现免费 Agent】", "");
  if (!agents.length) {
    lines.push("- 今天没有发现同时满足“确认为 Agent 软件 + 软件免费 + 免费模型可用路径”的新项目。", "");
  } else {
    for (const agent of agents.slice(0, 8)) {
      lines.push(`### ${agent.name}`);
      lines.push(`- 结论：**${agent.recommendation}**（${agent.score}/100）`);
      lines.push(`- Agent 身份：${agent.eligibility.isAgent ? "已从名称/简介/主题确认" : "未确认"}`);
      lines.push(`- 软件免费：${agent.eligibility.softwareFree ? "已确认开源许可证" : "未确认"}`);
      lines.push(`- 免费模型路径：${agent.eligibility.freeModelPath ? "已找到本地模型或免费模型路径" : "未确认"}`);
      lines.push(`- 判断依据：${agent.eligibility.reason}`);
      lines.push(`- Star：${agent.stars || 0}`);
      lines.push(`- 地址：${agent.url}`);
      lines.push("");
    }
  }

  lines.push("## 【风险与未确认】", "");
  lines.push("- 新模型上线不等于更适合生产；必须经过同任务对比、JSON 稳定性和至少短期稳定性观察。 ");
  lines.push("- 单次超时、429、503 或输出格式不标准不等于模型下线，先复测，不能据此自动替换。 ");
  lines.push("- 注册赠送额度、限时试用和一次性 Token 不视为长期免费，只能归为 C 级。 ");
  lines.push("- 新 Agent 即使开源，也可能依赖额外付费服务；只有找到无需购买付费模型的实际路径才进入推荐区。 ");
  if (sourceErrors.length) lines.push(`- 数据源异常：${sourceErrors.slice(0, 8).join("；")}`);
  lines.push("");

  lines.push("## 【今天需要做什么】", "");
  if (verifiedNewModels.length) {
    lines.push("- 对新出现的 A 级免费模型做同一组业务任务对比，至少观察稳定性后再决定是否人工替换共享注册表。 ");
  } else {
    lines.push("- 当前生产免费模型保持不变；继续监控官方模型列表、免费额度和下线通知。 ");
  }
  lines.push("- 任何生产模型替换都必须人工确认；本雷达不会自动改动两个现有生产项目。 ");
  return lines.join("\n");
}

function buildAlert(alerts) {
  const lines = [`# 免费 AI 资源变化提醒｜${dateCN}`, ""];
  alerts.forEach((a) => lines.push(`- ${a}`));
  lines.push("", "此提醒只表示模型、接口或免费证据发生变化，不代表应立即替换生产模型。先核验，再人工确认。");
  return lines.join("\n");
}

async function run() {
  const config = await loadJson(CONFIG_PATH, null);
  const registry = await loadJson(REGISTRY_PATH, null);
  const state = await loadJson(STATE_PATH, currentStateDefault());
  if (!config || !registry?.providers?.length) throw new Error("配置或共享免费模型注册表缺失");
  const sameDayRerun = (state.runs || []).some((r) => r.date === dateCN);

  const providerResults = [];
  const alerts = [];
  for (const provider of registry.providers) {
    const previous = state.providers?.[provider.name] || {};
    const models = await fetchProviderModels(provider);
    const probe = await probeProviderModel(provider, provider.model);
    const watch = await fetchWatchEvidence(provider);
    const baseline = !previous.lastCheckedAt;
    const rawDiff = models.ok && !baseline
      ? diffModels(previous.modelIds || [], models.ids, provider.model)
      : { added: [], removed: [], currentMissing: models.ok ? !models.ids.includes(provider.model) : false };
    const definitiveUnavailable = probe.status === "http_404" || probe.status === "http_410";
    const diff = { ...rawDiff, currentMissing: Boolean(rawDiff.currentMissing && definitiveUnavailable) };
    const watchHashes = watch.sources.map((s) => s.hash);
    const watchChanged = baseline ? false : changedHashes(previous.watchHashes || [], watchHashes);

    const newCandidates = [];
    for (const model of diff.added.slice(0, 5)) {
      const free = freeLevelFromEvidence({ modelId: model, text: watch.combinedText });
      let candidateProbe = { ok: false, status: "未测试" };
      if (free.level === "A") candidateProbe = await probeProviderModel(provider, model);
      newCandidates.push({
        model,
        freeLevel: free.level,
        freeReason: free.reason,
        probeOk: candidateProbe.ok,
        probeStatus: candidateProbe.status
      });
    }

    const decision = replacementDecision({ currentHealthy: probe.ok, currentMissing: diff.currentMissing, newCandidates });
    if (!baseline && previous.currentHealth === "ok" && !probe.ok) alerts.push(`${provider.displayName} 当前生产模型 ${provider.model} 从正常变为 ${probe.status}；先复测，不自动替换。`);
    if (diff.currentMissing) alerts.push(`${provider.displayName} 当前生产模型 ${provider.model} 在模型列表中消失且直接调用也失败，需要人工核验替代。`);
    for (const candidate of newCandidates.filter((c) => c.freeLevel === "A" && c.probeOk)) {
      alerts.push(`${provider.displayName} 新发现 A 级免费候选 ${candidate.model}，最小调用成功；建议进入对比测试，不自动替换。`);
    }

    providerResults.push({ provider, models, probe, watch, diff, watchChanged, newCandidates, decision });
  }

  const watchOnlyResults = [];
  for (const entry of config.watch_only_providers || []) {
    const previous = state.watchOnly?.[entry.name] || {};
    const watch = await fetchWatchEvidence(entry);
    const hashes = watch.sources.map((s) => s.hash);
    watchOnlyResults.push({ entry, watch, hashes, changed: previous.lastCheckedAt ? changedHashes(previous.hashes || [], hashes) : false });
  }

  const [ghApi, ghAgent, hn, brave] = await Promise.all([
    collectGitHubLeads({ token: process.env.GITHUB_TOKEN, queries: config.scan.github_api_queries, lookbackDays: config.scan.lookback_days, max: config.scan.max_api_leads, kind: "api" }),
    collectGitHubLeads({ token: process.env.GITHUB_TOKEN, queries: config.scan.github_agent_queries, lookbackDays: config.scan.lookback_days, max: config.scan.max_agent_leads, kind: "agent" }),
    collectHackerNews({ queries: config.scan.hn_queries, lookbackDays: config.scan.lookback_days, max: 24 }),
    collectBraveFreeAi({ apiKey: process.env.BRAVE_SEARCH_API_KEY, max: 20 })
  ]);

  const seenLeadUrls = sameDayRerun ? new Set() : new Set(state.seenLeadUrls || []);
  const apiLeadsAll = dedupeByUrl([...ghApi.leads, ...hn.leads, ...brave.leads]);
  const apiLeads = apiLeadsAll.filter((x) => !seenLeadUrls.has(x.url)).slice(0, config.scan.max_report_api_candidates);

  const enrichedAgents = await enrichAgentRepos(dedupeByUrl(ghAgent.leads), { token: process.env.GITHUB_TOKEN, max: 18 });
  const seenAgentUrls = sameDayRerun ? new Set() : new Set(state.seenAgentUrls || []);
  const agents = enrichedAgents
    .map((repo) => {
      const eligibility = agentEligibility(repo);
      const score = scoreAgent(repo);
      return { ...repo, eligibility, score, recommendation: recommendationForAgent(score, eligibility.eligible, repo.stars || 0) };
    })
    .filter((repo) => repo.eligibility.eligible && !seenAgentUrls.has(repo.url))
    .sort((a, b) => b.score - a.score || b.stars - a.stars)
    .slice(0, config.scan.max_report_agents);

  const sourceErrors = [
    ...ghApi.errors,
    ...ghAgent.errors,
    ...hn.errors,
    ...brave.errors,
    ...providerResults.flatMap((r) => r.watch.errors.map((e) => `${r.provider.displayName}: ${e}`)),
    ...watchOnlyResults.flatMap((r) => r.watch.errors.map((e) => `${r.entry.displayName}: ${e}`))
  ];

  const report = buildReport({ providerResults, watchOnlyResults, apiLeads, agents, sourceErrors });
  const alertReport = alerts.length ? buildAlert(alerts) : "";
  const outputDir = dryRun ? path.join(os.tmpdir(), "free-ai-resource-radar-dryrun") : REPORT_DIR;
  await fs.mkdir(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `free-ai-resource-radar-${dateCN}.md`);
  const alertPath = path.join(outputDir, `free-ai-resource-alert-${dateCN}.md`);
  await fs.writeFile(reportPath, report, "utf8");
  if (alertReport) {
    await fs.writeFile(alertPath, alertReport, "utf8");
  } else if (!dryRun) {
    try { await fs.unlink(alertPath); } catch {}
  }

  if (!dryRun) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const nextProviders = Object.fromEntries(providerResults.map((r) => [r.provider.name, {
      currentModel: r.provider.model,
      currentHealth: r.probe.ok ? "ok" : r.probe.status,
      jsonProbeOk: Boolean(r.probe.jsonOk),
      modelIds: r.models.ok ? r.models.ids.slice(0, 500) : (state.providers?.[r.provider.name]?.modelIds || []),
      watchHashes: r.watch.sources.map((s) => s.hash),
      lastCheckedAt: now.toISOString()
    }]));
    const nextWatchOnly = Object.fromEntries(watchOnlyResults.map((r) => [r.entry.name, { hashes: r.hashes, lastCheckedAt: now.toISOString() }]));
    const nextState = {
      schemaVersion: 1,
      updatedAt: now.toISOString(),
      providers: nextProviders,
      watchOnly: nextWatchOnly,
      seenLeadUrls: [...new Set([...(state.seenLeadUrls || []), ...apiLeadsAll.map((x) => x.url).filter(Boolean)])].slice(-800),
      seenAgentUrls: [...new Set([...(state.seenAgentUrls || []), ...enrichedAgents.filter((x) => agentEligibility(x).eligible).map((x) => x.url).filter(Boolean)])].slice(-800),
      runs: [...(state.runs || []).filter((r) => r.date !== dateCN).slice(-89), {
        date: dateCN,
        checkedProviders: providerResults.length,
        newApiLeads: apiLeads.length,
        newAgents: agents.length,
        alerts: alerts.length
      }]
    };
    await fs.writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  }

  const gmailReady = [process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET, process.env.GMAIL_REFRESH_TOKEN, process.env.REPORT_RECIPIENT_EMAIL].every(Boolean);
  if (!dryRun && gmailReady && config.notifications.daily_report) {
    const to = process.env.REPORT_RECIPIENT_EMAIL;
    await sendGmail({
      markdown: report,
      subject: `免费 AI 资源雷达｜${dateCN}`,
      from: process.env.GMAIL_SENDER_EMAIL || to,
      to,
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN
    });
    if (alertReport && config.notifications.change_alerts) {
      await sendGmail({
        markdown: alertReport,
        subject: `免费 AI 资源变化提醒｜${dateCN}`,
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
    providers: providerResults.map((r) => ({ name: r.provider.name, model: r.provider.model, health: r.probe.status, jsonOk: Boolean(r.probe.jsonOk), newModels: r.diff.added.length })),
    newApiLeads: apiLeads.length,
    newAgents: agents.length,
    alerts: alerts.length
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}

export { buildAlert, buildReport, changedHashes, providerLine, run };
