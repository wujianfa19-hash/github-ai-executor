// GitHub AI 每日情报 - 自动化测试
// 运行：node --test 02_程序组件/GitHubAI云端日报/daily.test.mjs
// 覆盖：空候选、去重、dry-run、评分上限、规则模板、fixture、unavailableSources 记录
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  score,
  classify,
  majorReleaseBasis,
  buildRanked,
  searchRepositories,
  validateReportStructure,
  reportQualityScore,
  buildDeepSeekMessages,
  generateDeepSeekReport,
  withQualityNotice,
  buildRuleReport,
  markdownToHtml,
  toEmailRaw,
  saveReport,
  recentHistorySet,
  runMain,
  deps,
  formatDate
} from "./daily.mjs";

const ORIGINAL_DEEPSEEK_KEY = process.env.DEEPSEEK_KEY;
delete process.env.DEEPSEEK_KEY;
process.on("exit", () => {
  if (ORIGINAL_DEEPSEEK_KEY === undefined) delete process.env.DEEPSEEK_KEY;
  else process.env.DEEPSEEK_KEY = ORIGINAL_DEEPSEEK_KEY;
});

// ---------- fixture ----------
function makeRepo(overrides = {}) {
  return {
    fullName: "owner/repo",
    url: "https://github.com/owner/repo",
    source: "GitHub Search: topic:llm",
    description: "An AI agent framework for coding",
    readmePreview: "x".repeat(900),
    stars: 5000,
    forks: 300,
    language: "Python",
    pushedAt: new Date().toISOString(),
    createdAt: new Date(Date.now() - 10 * 86400000).toISOString(),
    license: "MIT",
    topics: ["llm", "agent"],
    latestRelease: null,
    recentCommitCount: 5,
    ...overrides
  };
}

function makeHistory(dateStr, repos) {
  return { schemaVersion: 1, reports: [{ date: dateStr, repositories: repos }] };
}

function fieldValues(report, field) {
  const pattern = new RegExp(`\\*\\*${field}：\\*\\*\\s*([^\\n]+)`, "g");
  return [...report.matchAll(pattern)].map((match) => match[1].trim());
}

function makeValidReport(repos) {
  const lines = [
    "# GitHub AI 每日情报｜2099-01-02",
    "**报告日期：** 2099-01-02",
    "**检索时间范围：** 最近24小时及最近7天",
    "**实际访问的数据源：** GitHub Trending（热门项目榜）、GitHub Search API（代码仓库搜索接口）",
    "**无法访问的数据源：** 无",
    "## 今日一句话趋势",
    "**今日重点：** AI Agent（人工智能智能体）项目保持活跃，开发者持续关注自动化工作流、知识检索和本地推理能力。",
    "## 今日必看Top 3"
  ];
  repos.forEach((repo, index) => {
    if (index === 3) lines.push("## 今日潜力项目");
    lines.push(`### ${index + 1}. ${repo.fullName}`);
    lines.push(`**GitHub地址：** ${repo.url}`);
    lines.push(`**项目分类：** ${repo.category || "AI Agent与自动化"}`);
    lines.push("**一句话介绍：** 这是一个帮助开发者构建人工智能自动化流程的开源项目。");
    lines.push("**主要解决什么问题：** 它减少重复操作，并让人工智能程序按照既定步骤调用外部工具完成任务。");
    lines.push("**今日新增Star：** 未获取到");
    lines.push(`**总Star数：** ${repo.stars}`);
    lines.push(`**Fork数：** ${repo.forks}`);
    lines.push(`**主要编程语言：** ${repo.language}`);
    lines.push(`**最近更新时间：** ${repo.pushedAt}`);
    lines.push(`**开源许可证：** ${repo.license}`);
    lines.push("**热度或增长依据：** GitHub Search（代码仓库搜索）命中，最近仍有代码提交记录。");
    lines.push("**新项目池：** 30天优选；最近 30 天内创建");
    lines.push("**核心亮点：** 项目提供公开代码、说明文档和基础使用示例，具备进一步测试的条件。");
    lines.push("**适合哪些人：** 需要研究智能体、自动化流程或开源工具的开发者和产品人员。");
    lines.push("**实际使用场景：** 可用于技术选型、源码学习、自动化方案验证和小规模试用。");
    lines.push("**潜在缺点或风险：** 目前只核对公开资料，没有实际运行代码，功能效果仍需独立验证。");
    lines.push("**专业名词注释：** AI Agent（人工智能智能体）；Star（GitHub 用户收藏量）；Fork（代码分支副本）；README（项目说明文档）。");
    lines.push(`**综合评分：** ${repo.score || 80}/100`);
    lines.push("**推荐等级：** 值得关注");
  });
  if (repos.length < 4) lines.push("## 今日潜力项目\n无其他项目。");
  lines.push("## 今日版本更新\n未发现重大版本。");
  lines.push("## 趋势观察\n- **智能体方向：** AI Agent（人工智能智能体）仍然活跃。\n- **推理方向：** Inference（模型推理）值得持续跟踪。");
  lines.push("## 行动建议\n**最值得收藏：** owner/repo\n**最值得立即试用：** owner/repo\n**最适合研究源码：** owner/repo\n**未来一个月可能继续增长：** owner/repo");
  return lines.join("\n");
}

// ---------- 评分：真正的 100 分制，上限 100 下限 0 ----------
test("score: 100 分制，热门完整项目应为高分但不机械满分", () => {
  const repo = makeRepo({
    stars: 1_000_000,
    source: "GitHub Trending daily",
    recentCommitCount: 5,
    license: "MIT",
    readmePreview: "x".repeat(1200)
  });
  const s = score(repo);
  assert.ok(s >= 0 && s <= 100, `score=${s} should be in [0,100]`);
  assert.ok(s >= 75 && s < 100, `高质量项目应有区分度，实际 score=${s}`);
});

test("score: 冷门/信息缺失项目分数低但不为负", () => {
  const repo = makeRepo({
    stars: 0,
    source: "GitHub Search: created: AI",
    description: "",
    readmePreview: "",
    license: "未获取到",
    recentCommitCount: 0,
    pushedAt: new Date(Date.now() - 10 * 86400000).toISOString()
  });
  const s = score(repo);
  assert.ok(s >= 0 && s <= 100, `score=${s} should be in [0,100]`);
});

test("classify: 不把本地推理和 Web UI 误判成 Agent", () => {
  assert.equal(classify(makeRepo({
    fullName: "ollama/ollama",
    description: "Run LLM models locally",
    readmePreview: "local ai model inference server docker",
    topics: ["local-ai", "llm"]
  })), "推理框架与AI基础设施");
  assert.equal(classify(makeRepo({
    fullName: "open-webui/open-webui",
    description: "User-friendly WebUI for LLMs",
    readmePreview: "web interface chat interface local models",
    topics: ["webui", "llm"]
  })), "AI应用与效率工具");
  assert.equal(classify(makeRepo({
    fullName: "milvus-io/milvus",
    description: "Vector database for similarity search and RAG",
    readmePreview: "vector search embedding database",
    topics: ["vector-database", "rag"]
  })), "RAG、知识库与记忆系统");
  assert.equal(classify(makeRepo({
    fullName: "simstudioai/sim",
    description: "Build, deploy, and orchestrate AI agents",
    readmePreview: "Includes optional RAG knowledge base and MCP integrations",
    topics: ["ai-agent", "automation"]
  })), "AI Agent与自动化", "README 中的 RAG/MCP 不应盖过简介中的 Agent 主定位");
  assert.equal(classify(makeRepo({
    fullName: "google-gemini/gemini-cli",
    description: "Open-source AI agent for the terminal",
    readmePreview: "MCP support and tool calling",
    topics: ["cli", "terminal", "ai"]
  })), "AI编程与开发工具", "gemini-cli 应优先按命令行开发工具分类");
});

test("searchRepositories: 所有查询都限制在 90 天硬上限内", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  const expectedCreatedCutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      text: async () => JSON.stringify({ items: [{ full_name: "new/ai-tool" }] })
    };
  };
  try {
    const found = await searchRepositories();
    assert.ok(found.length > 0);
    assert.ok(urls.length >= 20, "应覆盖足够多 AI 应用和 AI 增强基础设施关键词");
    for (const url of urls) {
      const query = decodeURIComponent(new URL(url).searchParams.get("q"));
      assert.ok(query.includes("created:>="), `查询必须包含创建时间硬限制：${query}`);
      assert.ok(query.includes(`created:>=${expectedCreatedCutoff}`), `查询必须使用 90 天硬上限：${query}`);
      assert.ok(query.includes("stars:>2"), `查询必须包含最低热度门槛：${query}`);
    }
    assert.ok(urls.some((url) => decodeURIComponent(new URL(url).searchParams.get("q")).includes("benchmark LLM")), "应覆盖评测/benchmark");
    assert.ok(urls.some((url) => decodeURIComponent(new URL(url).searchParams.get("q")).includes("model router")), "应覆盖模型路由");
    assert.ok(urls.some((url) => decodeURIComponent(new URL(url).searchParams.get("q")).includes("quantization")), "应覆盖量化/降本");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildRuleReport: README 次要能力不进入项目主文案", () => {
  const repo = makeRepo({
    rank: 1,
    fullName: "ollama/ollama",
    url: "https://github.com/ollama/ollama",
    category: "推理框架与AI基础设施",
    description: "Run LLM models locally",
    topics: ["local-ai", "llm"],
    readmePreview: "Supports optional coding agents and developer tools",
    score: 80
  });
  const report = buildRuleReport([repo], { reportDate: "2026-08-05", availableSources: ["GitHub Search API"], unavailableSources: [] });
  const intro = fieldValues(report, "一句话介绍")[0];
  assert.ok(report.includes("### 1. ollama/ollama（"), "项目标题应包含创建日期");
  assert.ok(report.includes("优先最近 30 天内创建"), "报告顶部应说明 30 天优选规则");
  assert.ok(intro.includes("本地 AI 运行器") || intro.includes("自己电脑或服务器"), `应使用新手能懂的本地运行解释：${intro}`);
  assert.equal(intro.includes("AI 程序员助手"), false, `README 次要词不应进入主介绍：${intro}`);
});

// ---------- 去重：3 天内已报道项目默认排除 ----------
test("buildRanked: 3 天内已报道项目默认排除", () => {
  const historySet = new Set(["owner/repo"]);
  const repo = makeRepo({ fullName: "owner/repo" });
  const ranked = buildRanked([repo], historySet);
  assert.equal(ranked.length, 0, "3 天内已报道且无重大 Release 应被排除");
});

test("buildRanked: 24 小时内重大 Release 才允许重复并给出真实依据", () => {
  const historySet = new Set(["owner/repo"]);
  const repo = makeRepo({
    fullName: "owner/repo",
    latestRelease: {
      name: "v2.0",
      tag: "v2.0.0",
      publishedAt: new Date(Date.now() - 2 * 3600000).toISOString()
    },
    previousReleaseTag: "v1.9.0"
  });
  const ranked = buildRanked([repo], historySet);
  assert.equal(ranked.length, 1, "24 小时内重大 Release 应允许重复收录");
  assert.equal(ranked[0].repeated, true);
  assert.ok(ranked[0].repeatedReason.includes("v2.0.0"), "重复原因应包含真实 Release 依据");
});

test("buildRanked: 超过 90 天创建的老项目即使高 Star 也排除", () => {
  const oldHot = makeRepo({
    fullName: "old/hot-ai",
    stars: 999999,
    forks: 9999,
    createdAt: new Date(Date.now() - 91 * 86400000).toISOString()
  });
  const newSmall = makeRepo({
    fullName: "new/small-ai",
    stars: 20,
    forks: 1,
    createdAt: new Date(Date.now() - 3 * 86400000).toISOString()
  });
  const ranked = buildRanked([oldHot, newSmall], new Set());
  assert.deepEqual(ranked.map((repo) => repo.fullName), ["new/small-ai"]);
});

test("buildRanked: 31-90 天补充池信号不足时排除", () => {
  const weakExtended = makeRepo({
    fullName: "extended/weak-ai",
    stars: 20,
    forks: 1,
    recentCommitCount: 0,
    readmePreview: "short",
    pushedAt: new Date(Date.now() - 20 * 86400000).toISOString(),
    createdAt: new Date(Date.now() - 45 * 86400000).toISOString(),
    latestRelease: null
  });
  const ranked = buildRanked([weakExtended], new Set());
  assert.equal(ranked.length, 0, "31-90 天项目必须有明显热度或质量信号才进入补充池");
});

test("buildRanked: 31-90 天补充池强信号项目可入选并标注原因", () => {
  const strongExtended = makeRepo({
    fullName: "extended/strong-ai",
    stars: 500,
    forks: 50,
    readmePreview: "Agent RAG MCP quickstart docker example ".repeat(40),
    pushedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    createdAt: new Date(Date.now() - 45 * 86400000).toISOString()
  });
  const ranked = buildRanked([strongExtended], new Set());
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].ageBucket, "extended");
  assert.ok(ranked[0].ageReason.includes("31-90 天补充池"), "补充池项目应给出入选原因");
  assert.ok(ranked[0].ageReason.includes("总 Star") || ranked[0].ageReason.includes("Fork"), "入选原因应包含可解释信号");
});

test("buildRuleReport: 补充池项目在报告中显示补充观察依据", () => {
  const repo = {
    ...makeRepo({
      rank: 1,
      fullName: "extended/strong-ai",
      createdAt: new Date(Date.now() - 45 * 86400000).toISOString()
    }),
    category: "AI Agent与自动化",
    score: 83,
    ageBucket: "extended",
    ageReason: "31-90 天补充池：总 Star ≥ 300；Fork ≥ 30"
  };
  const report = buildRuleReport([repo], { reportDate: "2026-08-05", availableSources: ["GitHub Search API"], unavailableSources: [] });
  assert.ok(report.includes("**新项目池：** 补充观察；31-90 天补充池"), "报告应显示补充观察依据");
});

test("buildRanked: 最近 30 天新项目按热度排序", () => {
  const highHeat = makeRepo({
    fullName: "new/high-heat",
    stars: 500,
    forks: 80,
    recentCommitCount: 1,
    createdAt: new Date(Date.now() - 2 * 86400000).toISOString()
  });
  const lowHeat = makeRepo({
    fullName: "new/low-heat",
    stars: 100,
    forks: 5,
    recentCommitCount: 5,
    readmePreview: "x".repeat(2000),
    createdAt: new Date(Date.now() - 1 * 86400000).toISOString()
  });
  const ranked = buildRanked([lowHeat, highHeat], new Set());
  assert.equal(ranked[0].fullName, "new/high-heat");
  assert.ok(ranked[0].heatScore > ranked[1].heatScore);
});

test("majorReleaseBasis: 0.0.x 初版不算重大 Release", () => {
  const repo = makeRepo({
    latestRelease: { name: "v0.0.1", tag: "v0.0.1", publishedAt: new Date().toISOString() },
    previousReleaseTag: "v0.0.0"
  });
  assert.equal(majorReleaseBasis(repo), null);
});

test("majorReleaseBasis: 0.x 版本不算重大 Release（收紧）", () => {
  const repo = makeRepo({
    latestRelease: { name: "v0.5.0", tag: "v0.5.0", publishedAt: new Date().toISOString() },
    previousReleaseTag: "v0.4.0"
  });
  assert.equal(majorReleaseBasis(repo), null, "0.x 不应判定为重大 Release");
});

test("majorReleaseBasis: 预发布（pre-release）不算", () => {
  const repo = makeRepo({
    latestRelease: { name: "v2.0.0-beta", tag: "v2.0.0-beta", publishedAt: new Date().toISOString(), prerelease: true },
    previousReleaseTag: "v1.9.0"
  });
  assert.equal(majorReleaseBasis(repo), null, "pre-release 不应判定为重大 Release");
});

test("majorReleaseBasis: 无前版本可对比时不算（收紧）", () => {
  const repo = makeRepo({
    latestRelease: { name: "v1.0.0", tag: "v1.0.0", publishedAt: new Date().toISOString() },
    previousReleaseTag: null
  });
  assert.equal(majorReleaseBasis(repo), null, "无前版本时不应判定为重大 Release");
});

test("majorReleaseBasis: 正式版本且有前版本则返回依据", () => {
  const repo = makeRepo({
    latestRelease: { name: "v2.0.0", tag: "v2.0.0", publishedAt: new Date().toISOString() },
    previousReleaseTag: "v1.8.0"
  });
  const basis = majorReleaseBasis(repo);
  assert.ok(basis && basis.includes("v2.0.0"), `应返回依据：${basis}`);
  assert.ok(basis.includes("v1.8.0"), "依据应包含上一版本");
});

test("majorReleaseBasis: 同一主版本的普通小版本不算重大", () => {
  const repo = makeRepo({
    latestRelease: { name: "v1.9.0", tag: "v1.9.0", publishedAt: new Date().toISOString() },
    previousReleaseTag: "v1.8.0"
  });
  assert.equal(majorReleaseBasis(repo), null);
});

test("majorReleaseBasis: 超过 24 小时的 Release 不算", () => {
  const repo = makeRepo({
    latestRelease: { name: "v1.5", tag: "v1.5.0", publishedAt: new Date(Date.now() - 3 * 86400000).toISOString() }
  });
  assert.equal(majorReleaseBasis(repo), null);
});

test("recentHistorySet: 只保留 3 天窗口", () => {
  const old = makeHistory(new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), ["old/repo"]);
  const recent = makeHistory(new Date().toISOString().slice(0, 10), ["new/repo"]);
  const set = recentHistorySet({ reports: [...old.reports, ...recent.reports] });
  assert.ok(!set.has("old/repo"), "5 天前项目不在去重窗口");
  assert.ok(set.has("new/repo"), "3 天内项目应在去重窗口");
});

test("recentHistorySet: 同一天重跑时忽略当天历史", () => {
  const today = formatDate();
  const set = recentHistorySet(makeHistory(today, ["owner/repo"]), today);
  assert.ok(!set.has("owner/repo"), "当天重跑应重新生成同一批候选并覆盖报告");
});

// ---------- 报告结构与质量闸门 ----------
test("validateReportStructure: 正常 Markdown 报告通过", () => {
  const repo = makeRepo();
  const r = validateReportStructure(makeValidReport([repo]), [repo]);
  assert.equal(r.ok, true);
});

test("validateReportStructure: JSON 输出被拒绝", () => {
  const repo = makeRepo();
  const r = validateReportStructure(JSON.stringify({ report: "x" }), [repo]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("JSON"), `reason=${r.reason}`);
});

test("validateReportStructure: 未包含候选项目被拒绝", () => {
  const repo = makeRepo();
  const r = validateReportStructure("# 报告\n完全不相关的模型输出", [repo]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("遗漏候选项目"), `reason=${r.reason}`);
});

test("validateReportStructure: 虚构 Star 数据被拒绝", () => {
  const repo = makeRepo();
  const report = makeValidReport([repo]).replace("**今日新增Star：** 未获取到", "**今日新增Star：** 5000");
  const r = validateReportStructure(report, [repo]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("未获取到"), `reason=${r.reason}`);
});

test("validateReportStructure: 缺少固定栏目被拒绝", () => {
  const repo = makeRepo();
  const report = makeValidReport([repo]).replace("## 行动建议", "## 其他");
  const r = validateReportStructure(report, [repo]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("行动建议"), `reason=${r.reason}`);
});

test("validateReportStructure: 每个项目缺少专业名词注释时被拒绝", () => {
  const repo = makeRepo();
  const report = makeValidReport([repo]).replace(/^\*\*专业名词注释：\*\*.*$/m, "");
  const r = validateReportStructure(report, [repo]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("专业名词注释"), `reason=${r.reason}`);
});

test("validateReportStructure: 专业名词没有中文括号解释时被拒绝", () => {
  const repo = makeRepo();
  const report = makeValidReport([repo]).replace(
    /^\*\*专业名词注释：\*\*.*$/m,
    "**专业名词注释：** AI Agent、Star、Fork"
  );
  const r = validateReportStructure(report, [repo]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("英文术语（中文解释）"), `reason=${r.reason}`);
});

test("validateReportStructure: README 原始 HTML 被拒绝", () => {
  const repo = makeRepo();
  const report = `${makeValidReport([repo])}\n<div>raw readme</div>`;
  const r = validateReportStructure(report, [repo]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("原始 HTML"), `reason=${r.reason}`);
});

test("validateReportStructure: 多项目套话重复过高时被拒绝", () => {
  const repos = [1, 2, 3, 4].map((n) => makeRepo({
    fullName: `owner/repo-${n}`,
    url: `https://github.com/owner/repo-${n}`
  }));
  const r = validateReportStructure(makeValidReport(repos), repos);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("重复度过高"), `reason=${r.reason}`);
});

test("reportQualityScore: 合格报告通过，不合格报告低分", () => {
  const goodRepos = [
    makeRepo({
      fullName: "open/agent",
      url: "https://github.com/open/agent",
      description: "Autonomous AI agent with browser automation",
      readmePreview: "browser automation computer use quickstart",
      topics: ["agent"],
      category: "AI Agent与自动化",
      rank: 1,
      score: 86
    }),
    makeRepo({
      fullName: "vec/db",
      url: "https://github.com/vec/db",
      description: "Vector database for RAG",
      readmePreview: "vector search embedding database",
      topics: ["rag"],
      category: "RAG、知识库与记忆系统",
      rank: 2,
      score: 80
    }),
    makeRepo({
      fullName: "local/run",
      url: "https://github.com/local/run",
      description: "Run LLM models locally",
      readmePreview: "local ai model inference",
      topics: ["local-ai"],
      category: "推理框架与AI基础设施",
      rank: 3,
      score: 78
    })
  ];
  const good = buildRuleReport(goodRepos, { reportDate: "2026-08-04", availableSources: ["GitHub Search API"], unavailableSources: [] });
  assert.equal(reportQualityScore(good, goodRepos).ok, true);

  const badRepos = [1, 2, 3, 4].map((n) => makeRepo({ fullName: `owner/repo-${n}`, url: `https://github.com/owner/repo-${n}` }));
  const bad = makeValidReport(badRepos);
  const result = reportQualityScore(bad, badRepos);
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("重复度过高"), `reason=${result.reason}`);
});

test("buildRuleReport: 子数据源失败可见", () => {
  const repo = makeRepo({
    dataSources: {
      readme: "ok",
      release: "失败（404 Not Found: url）",
      commits: "失败（403 rate limit）"
    }
  });
  const report = buildRuleReport([repo], { reportDate: "2026-08-04", availableSources: [], unavailableSources: [] });
  assert.ok(report.includes("Release（版本发布记录）失败（404"), "应显示 Release 中文注释和失败原因");
  assert.ok(report.includes("Commit（代码提交记录）失败（403"), "应显示 Commit 中文注释和失败原因");
});

test("buildRuleReport: 顶部不输出工程生成说明", () => {
  const repo = makeRepo();
  const report = buildRuleReport([repo], { reportDate: "2026-08-04", availableSources: ["GitHub Trending"], unavailableSources: [] });
  assert.equal(report.includes("规则模板生成，未调用任何模型 API"), false, "正常报告不应输出工程生成说明");
  assert.equal(report.includes("模型数据源不可用"), false, "纯模板模式不应出现模型不可用提示");
  assert.ok(report.includes("owner/repo"), "应包含项目");
});

test("buildRuleReport: 使用中文归纳、专业名词注释和重点粗体", () => {
  const repo = makeRepo({
    description: "An AI agent framework that should never be copied verbatim",
    readmePreview: '<div><img src="bad">Raw English README</div>',
    category: "AI Agent与自动化",
    rank: 1,
    score: 82
  });
  const report = buildRuleReport([repo], { reportDate: "2026-08-04", availableSources: ["GitHub Trending"], unavailableSources: [] });
  assert.ok(report.includes("**专业名词注释：**"), "应包含专业名词注释字段");
  assert.ok(report.includes("AI Agent（"), "应解释 AI Agent");
  assert.ok(report.includes("**核心亮点：**"), "重点字段应使用 Markdown 粗体");
  assert.equal(report.includes(repo.description), false, "不得复制英文项目简介");
  assert.equal(report.includes("Raw English README"), false, "不得复制 README 原文");
  assert.equal(report.includes("<div>"), false, "不得输出 README HTML");
});

test("buildRuleReport: 不同类型项目生成差异化文案", () => {
  const repos = [
    makeRepo({
      rank: 1,
      fullName: "open/agent",
      url: "https://github.com/open/agent",
      category: "AI Agent与自动化",
      description: "Autonomous AI agent with browser automation and tool calling",
      readmePreview: "browser automation computer use tool calling quickstart",
      topics: ["agent", "browser-automation"],
      score: 86
    }),
    makeRepo({
      rank: 2,
      fullName: "vec/db",
      url: "https://github.com/vec/db",
      category: "RAG、知识库与记忆系统",
      description: "Vector database for similarity search and RAG",
      readmePreview: "vector search embedding database rag docs",
      topics: ["vector-database", "rag"],
      language: "Go",
      score: 80
    }),
    makeRepo({
      rank: 3,
      fullName: "local/run",
      url: "https://github.com/local/run",
      category: "推理框架与AI基础设施",
      description: "Run LLM models locally with inference runtime",
      readmePreview: "local ai model inference server gpu docker",
      topics: ["local-ai", "inference"],
      language: "Rust",
      score: 78
    })
  ];
  const report = buildRuleReport(repos, { reportDate: "2026-08-04", availableSources: ["GitHub Search API"], unavailableSources: [] });
  for (const field of ["一句话介绍", "主要解决什么问题", "核心亮点", "实际使用场景", "潜在缺点或风险"]) {
    const values = fieldValues(report, field);
    assert.equal(new Set(values).size, values.length, `${field} 不应重复：${values.join(" | ")}`);
  }
  assert.ok(report.includes("会操作浏览器的助手"), "Agent 项目应使用浏览器自动化的大白话解释");
  assert.ok(report.includes("按意思找内容"), "RAG 项目应使用向量检索的大白话解释");
  assert.ok(report.includes("本地 AI 运行器"), "推理项目应使用本地模型运行的大白话解释");
});

test("buildDeepSeekMessages: 使用规则模板和真实仓库事实约束模型", () => {
  const repo = { ...makeRepo({ rank: 1, category: "AI Agent与自动化", score: 82 }), ageBucket: "primary", ageReason: "最近 30 天内创建" };
  const template = buildRuleReport([repo], { reportDate: "2026-08-05", availableSources: ["GitHub Search API"], unavailableSources: [] });
  const messages = buildDeepSeekMessages([repo], {
    reportDate: "2026-08-05",
    timeRange: "优先最近 30 天内创建",
    availableSources: ["GitHub Search API"],
    unavailableSources: []
  }, template);
  const prompt = messages.map((m) => m.content).join("\n");
  assert.ok(prompt.includes("规则模板底稿"), "应把规则模板作为底稿交给模型");
  assert.ok(prompt.includes(repo.fullName), "应包含真实仓库名");
  assert.ok(prompt.includes("严禁虚构"), "应明确禁止虚构数据");
  assert.ok(prompt.includes("新项目池"), "应要求模型保留新项目池字段");
  assert.ok(prompt.includes("完全不懂开源的新手"), "应要求 DeepSeek 使用小白友好解释");
  assert.ok(prompt.includes("术语（中文解释）"), "应要求专业词紧跟中文解释");
});

test("generateDeepSeekReport: DeepSeek 合格输出直接采用", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_KEY;
  process.env.DEEPSEEK_KEY = "test-key";
  const repo = { ...makeRepo({ rank: 1, category: "AI Agent与自动化", score: 82 }), ageBucket: "primary", ageReason: "最近 30 天内创建" };
  const modelJson = JSON.stringify({ projects: [{
    fullName: repo.fullName,
    shortIntro: "它像一个会帮你点按钮的 AI Agent。",
    problem: "以前要手动开网页和调 API，现在可以让它按步骤跑。",
    highlights: "支持 CLI 和 Docker，适合快速试用。",
    audience: "适合想验证 AI 自动化的开发者和产品负责人。",
    useCases: "比如让 AI 打开网页、整理资料、再生成处理结果。",
    risks: "要小心账号权限和误操作，先在测试环境跑。",
    attentionReason: "最近创建且命中 AI Agent 方向，值得观察。",
    difference: "更偏任务执行，不只是聊天问答。",
    deployAdvice: "可以先小范围试用，不要直接接生产账号。"
  }] });
  let called = false;
  globalThis.fetch = async (url, options) => {
    called = true;
    assert.ok(String(url).includes("/chat/completions"));
    const body = JSON.parse(options.body);
    assert.equal(body.model, "deepseek-v4-pro");
    return {
      ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: modelJson } }] })
    };
  };
  try {
    const report = await generateDeepSeekReport([repo], { reportDate: "2099-01-02", availableSources: [], unavailableSources: [] }, makeValidReport([repo]));
    assert.ok(report.includes("AI Agent（人工智能智能体）"), "模型文案里的 AI Agent 应自动补中文解释");
    assert.ok(report.includes("API（程序接口）"), "模型文案里的 API 应自动补中文解释");
    assert.ok(report.includes("CLI（命令行工具）"), "模型文案里的 CLI 应自动补中文解释");
    assert.ok(report.includes("Docker（打包部署工具）"), "模型文案里的 Docker 应自动补中文解释");
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_KEY;
    else process.env.DEEPSEEK_KEY = originalKey;
  }
});

test("generateDeepSeekReport: 首次输出不合格时会带原因重试", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.DEEPSEEK_KEY;
  process.env.DEEPSEEK_KEY = "test-key";
  const repo = { ...makeRepo({ rank: 1, category: "AI Agent与自动化", score: 82 }), ageBucket: "primary", ageReason: "最近 30 天内创建" };
  const modelJson = JSON.stringify({ projects: [{
    fullName: repo.fullName,
    shortIntro: "它像一个会帮你点按钮的 AI 助手。",
    problem: "减少人工重复操作，让 AI 按步骤调用工具。",
    highlights: "重点是把浏览器自动化和工具调用做成可试用流程。",
    audience: "适合想验证 AI 自动化的开发者和产品负责人。",
    useCases: "比如让 AI 打开网页、整理资料、再生成处理结果。",
    risks: "要小心账号权限和误操作，先在测试环境跑。",
    attentionReason: "最近创建且命中 AI Agent 方向，值得观察。",
    difference: "更偏任务执行，不只是聊天问答。",
    deployAdvice: "可以先小范围试用，不要直接接生产账号。"
  }] });
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    if (calls === 2) {
      assert.ok(body.messages[1].content.includes("上一次输出不合格"), "第二次应带修复原因");
    }
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: calls === 1 ? "# 坏报告" : modelJson } }]
      })
    };
  };
  try {
    const report = await generateDeepSeekReport([repo], { reportDate: "2099-01-02", availableSources: [], unavailableSources: [] }, makeValidReport([repo]));
    assert.ok(report.includes("它像一个会帮你点按钮的 AI 助手。"));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.DEEPSEEK_KEY;
    else process.env.DEEPSEEK_KEY = originalKey;
  }
});

test("markdownToHtml: 彩色标题、关键词高亮和 GitHub 地址转换成邮件 HTML", () => {
  const html = markdownToHtml("# 日报\n## 今日必看Top 3\n### 1. owner/repo（2026.8.5）\n**推荐等级：** 强烈推荐\n**潜在缺点或风险：** 可能 404\n**专业名词注释：** RAG（检索增强生成）、API、Docker\nhttps://github.com/owner/repo");
  assert.ok(html.includes("<h1"), "一级标题应转换为 HTML 标题");
  assert.ok(html.includes("background:#ddf4ff"), "章节标题应有底色");
  assert.ok(html.includes("border-left:5px solid #2f81f7"), "项目块应有左侧强调线");
  assert.ok(html.includes("<strong>专业名词注释：</strong>"), "Markdown 粗体应转换为 strong");
  assert.ok(html.includes('href="https://github.com/owner/repo"'), "GitHub 地址应可点击");
  assert.ok(html.includes("#dafbe1"), "推荐结论应有绿色强调");
  assert.ok(html.includes("#ffebe9"), "风险内容应有红色强调");
  assert.ok(html.includes("#fff8c5"), "API/Star/Fork/Docker 等关键词应有橙色强调");
});

test("toEmailRaw: 邮件同时保留纯文本和 HTML 彩色版", () => {
  const raw = toEmailRaw({ from: "a@example.com", to: "b@example.com", subject: "测试", markdown: "**重点：** 中文内容" });
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  assert.ok(decoded.includes("multipart/alternative"), "应使用兼容性更好的 multipart 邮件");
  assert.ok(decoded.includes("Content-Type: text/plain; charset=UTF-8"), "应保留纯文本兜底");
  assert.ok(decoded.includes("Content-Type: text/html; charset=UTF-8"), "应包含 HTML 邮件");
  assert.ok(decoded.includes("<strong>重点：</strong>"));
});

// ---------- dry-run 隔离 ----------
test("saveReport: dry-run 写临时目录，不写正式文件", async () => {
  const originalDryRun = process.env.DRY_RUN;
  process.env.DRY_RUN = "1";
  try {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-test-"));
    const reportPath = await saveReport("# test", "2099-01-01", [makeRepo()], { reports: [] });
    assert.ok(reportPath.includes("github-ai-daily-dryrun"), "dry-run 报告应在临时目录");
    assert.ok(fs.existsSync(reportPath), "dry-run 报告文件应存在");
    // 不应在项目正式目录写入
    assert.ok(!fs.existsSync(path.join(process.cwd(), "04_运行数据", "reports", "github-ai-daily-2099-01-01.md")), "不应写正式报告");
  } finally {
    if (originalDryRun === undefined) delete process.env.DRY_RUN;
    else process.env.DRY_RUN = originalDryRun;
  }
});

// ---------- 空候选：立即失败 ----------
test("runMain: 空候选立即失败，禁止空日报", async () => {
  const originalDeps = { ...deps };
  deps.collectTrending = async () => [];
  deps.searchRepositories = async () => [];
  deps.formatDate = () => "2099-01-01";
  deps.loadHistory = async () => ({ reports: [] });
  let sendCalled = false;
  deps.sendGmail = async () => { sendCalled = true; return { id: "x" }; };
  deps.saveReport = async () => "/tmp/x.md";
  try {
    await assert.rejects(() => runMain(), /没有可报道的 AI 项目/);
    assert.equal(sendCalled, false, "空结果不应发送邮件");
  } finally {
    Object.assign(deps, originalDeps);
  }
});

// ---------- 仓库详情失败记录到 unavailableSources ----------
test("runMain: enrich 失败记录到 unavailableSources，不静默吞掉", async () => {
  const originalDeps = { ...deps };
  deps.collectTrending = async () => [{ fullName: "broken/repo", source: "GitHub Trending daily" }];
  deps.searchRepositories = async () => [];
  deps.formatDate = () => "2099-01-01";
  deps.loadHistory = async () => ({ reports: [] });
  deps.enrichCandidate = async () => { throw new Error("404 Not Found"); };
  deps.sendGmail = async () => { throw new Error("should not send"); };
  deps.saveReport = async () => "/tmp/x.md";
  try {
    // ranked 为空时抛出的异常中必须包含 unavailableSources 详情
    await assert.rejects(
      () => runMain(),
      (err) => {
        assert.ok(err.message.includes("没有可报道的 AI 项目"), "应提示空结果");
        assert.ok(
          err.message.includes("broken/repo") && err.message.includes("404"),
          `unavailableSources 应包含失败仓库与原因：${err.message}`
        );
        return true;
      }
    );
  } finally {
    Object.assign(deps, originalDeps);
  }
});

// ---------- 正常流程（fixture 全链路） ----------
test("runMain: fixture 全链路成功并发送", async () => {
  const originalDeps = { ...deps };
  deps.collectTrending = async () => [{ fullName: "fixture/agent", source: "GitHub Trending daily" }];
  deps.searchRepositories = async () => [{ fullName: "fixture/rag", source: "GitHub Search: RAG" }];
  deps.formatDate = () => "2099-01-02";
  deps.loadHistory = async () => ({ reports: [] });
  deps.enrichCandidate = async (c) =>
    makeRepo({
      fullName: c.fullName,
      source: c.source,
      description: "An AI agent framework",
      readmePreview: "x".repeat(900),
      stars: 8000,
      recentCommitCount: 4
    });
  let sent = null;
  deps.sendGmail = async (markdown, reportDate) => {
    sent = { id: "msg-1", reportDate };
    return sent;
  };
  let savedPath = null;
  deps.saveReport = async (markdown, reportDate, repos, history) => {
    savedPath = `/tmp/${reportDate}.md`;
    return savedPath;
  };
  try {
    await runMain();
    assert.ok(sent, "应调用发送");
    assert.equal(sent.reportDate, "2099-01-02");
    assert.ok(savedPath, "应保存报告");
  } finally {
    Object.assign(deps, originalDeps);
  }
});

test("runMain: 纯规则模板生成并发送，不调用模型 API", async () => {
  const originalDeps = { ...deps };
  const originalFetch = globalThis.fetch;
  const candidates = [
    { fullName: "fixture/agent", source: "GitHub Search: agent" },
    { fullName: "fixture/vector", source: "GitHub Search: rag" },
    { fullName: "fixture/local", source: "GitHub Search: local ai" }
  ];
  deps.collectTrending = async () => [];
  deps.searchRepositories = async () => candidates;
  deps.formatDate = () => "2099-01-03";
  deps.loadHistory = async () => ({ reports: [] });
  deps.enrichCandidate = async (c) => makeRepo({
    fullName: c.fullName,
    url: `https://github.com/${c.fullName}`,
    source: c.source,
    description: c.fullName.includes("vector") ? "Vector database for RAG" : c.fullName.includes("local") ? "Run LLM models locally" : "Autonomous AI agent",
    readmePreview: c.fullName.includes("vector") ? "vector search embedding database" : c.fullName.includes("local") ? "local ai model inference" : "browser automation tool calling",
    topics: c.fullName.includes("vector") ? ["rag"] : c.fullName.includes("local") ? ["local-ai"] : ["agent"],
    recentCommitCount: 4
  });
  let sentMarkdown = "";
  deps.sendGmail = async (markdown, reportDate) => {
    sentMarkdown = markdown;
    return { id: "msg-2", reportDate };
  };
  deps.saveReport = async () => "/tmp/2099-01-03.md";
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url).includes("/chat/completions"), false, "纯模板模式不应请求模型 API");
    return originalFetch(url, options);
  };
  try {
    await runMain();
    assert.equal(sentMarkdown.includes("规则模板生成，未调用任何模型 API"), false, "正常邮件不应输出工程生成说明");
    assert.ok(sentMarkdown.includes("fixture/vector"), "应包含候选项目");
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(deps, originalDeps);
  }
});

test("runMain: DeepSeek 失败时自动回退规则模板并继续发送", async () => {
  const originalDeps = { ...deps };
  const originalKey = process.env.DEEPSEEK_KEY;
  process.env.DEEPSEEK_KEY = "test-key";
  deps.collectTrending = async () => [{ fullName: "fixture/agent", source: "GitHub Search: agent" }];
  deps.searchRepositories = async () => [];
  deps.formatDate = () => "2099-01-05";
  deps.loadHistory = async () => ({ reports: [] });
  deps.enrichCandidate = async (c) => makeRepo({
    rank: 1,
    fullName: c.fullName,
    url: `https://github.com/${c.fullName}`,
    source: c.source,
    category: "AI Agent与自动化",
    score: 82
  });
  deps.generateDeepSeekReport = async () => { throw new Error("401 invalid key"); };
  let sentMarkdown = "";
  deps.sendGmail = async (markdown) => { sentMarkdown = markdown; return { id: "fallback" }; };
  deps.saveReport = async () => "/tmp/2099-01-05.md";
  try {
    await runMain();
    assert.ok(sentMarkdown.includes("fixture/agent"), "DeepSeek 失败后仍应发送模板报告");
    assert.ok(sentMarkdown.includes("DeepSeek 模型生成失败"), "报告顶部应记录模型数据源不可用原因");
  } finally {
    Object.assign(deps, originalDeps);
    if (originalKey === undefined) delete process.env.DEEPSEEK_KEY;
    else process.env.DEEPSEEK_KEY = originalKey;
  }
});

test("withQualityNotice: 合格报告不增加质量废话，低质量才标注复核", () => {
  const good = withQualityNotice("# 标题\n\n正文", {
    ok: true,
    score: 95,
    threshold: 85,
    reason: "ok"
  });
  assert.equal(good.includes("质量评分"), false);
  assert.equal(good.includes("质量复核"), false);

  const report = withQualityNotice("# 标题\n\n正文", {
    ok: false,
    score: 40,
    threshold: 85,
    reason: "测试原因"
  });
  assert.ok(report.includes("**需人工复核：** 质量分 40/85；测试原因"));
});

test("runMain: 规则模板质量不合格时仍发送并标注复核", async () => {
  const originalDeps = { ...deps };
  deps.collectTrending = async () => [{ fullName: "fixture/bad", source: "GitHub Trending daily" }];
  deps.searchRepositories = async () => [];
  deps.formatDate = () => "2099-01-04";
  deps.loadHistory = async () => ({ reports: [] });
  deps.enrichCandidate = async (c) => makeRepo({
    fullName: c.fullName,
    url: `https://github.com/${c.fullName}`,
    source: c.source,
    description: "Autonomous AI agent",
    readmePreview: "browser automation tool calling",
    topics: ["agent"],
    recentCommitCount: 4
  });
  deps.buildRuleReport = () => "# 坏报告\n<div>raw</div>";
  let sentMarkdown = "";
  let savedMarkdown = "";
  deps.sendGmail = async (markdown) => { sentMarkdown = markdown; return { id: "bad" }; };
  deps.saveReport = async (markdown) => { savedMarkdown = markdown; return "/tmp/bad.md"; };
  try {
    await runMain();
    assert.ok(sentMarkdown.includes("需人工复核"), "质量不合格仍发送，但必须提示复核");
    assert.ok(savedMarkdown.includes("需人工复核"), "质量不合格仍保存，但必须提示复核");
  } finally {
    Object.assign(deps, originalDeps);
  }
});

console.log("ALL_TESTS_REGISTERED");
