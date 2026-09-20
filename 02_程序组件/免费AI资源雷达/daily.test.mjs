import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  agentEligibility,
  diffModels,
  freeLevelFromEvidence,
  normalizeModelIds,
  recommendationForAgent,
  replacementDecision,
  scoreAgent
} from "./src/core.mjs";
import { buildReport, changedHashes } from "./daily.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("共享注册表强制免费且每家只保留一个模型", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "共享", "free-model-registry.json"), "utf8"));
  assert.equal(registry.policy.freeOnly, true);
  assert.equal(registry.policy.oneModelPerProvider, true);
  assert.equal(registry.policy.autoReplaceProduction, false);
  const names = new Set();
  for (const provider of registry.providers) {
    assert.ok(provider.name);
    assert.ok(provider.model);
    assert.ok(provider.endpoint);
    assert.equal(names.has(provider.name), false, `供应商重复：${provider.name}`);
    names.add(provider.name);
  }
});

test("normalizeModelIds 同时支持 OpenAI 与 Gemini 模型列表", () => {
  assert.deepEqual(normalizeModelIds({ data: [{ id: "b" }, { id: "a" }] }), ["a", "b"]);
  assert.deepEqual(normalizeModelIds({ models: [{ name: "models/gemini-x" }] }, "gemini"), ["gemini-x"]);
});

test("diffModels 能发现新增、下线和当前模型消失", () => {
  const result = diffModels(["a", "b"], ["b", "c"], "a");
  assert.deepEqual(result.added, ["c"]);
  assert.deepEqual(result.removed, ["a"]);
  assert.equal(result.currentMissing, true);
});

test("freeLevelFromEvidence 对 :free 直接判 A，对一次性试用判 C", () => {
  assert.equal(freeLevelFromEvidence({ modelId: "vendor/model:free", text: "" }).level, "A");
  assert.equal(freeLevelFromEvidence({ modelId: "model-x", text: "model-x signup credit trial only" }).level, "C");
});

test("Agent 必须同时满足 Agent 身份、软件免费和免费模型路径", () => {
  const good = agentEligibility({
    name: "owner/browser-agent",
    description: "Open source browser agent tool",
    topics: ["ai-agent"],
    license: "MIT",
    readme: "Install the agent and run it with Ollama local model."
  });
  assert.equal(good.eligible, true);
  const paidOnly = agentEligibility({
    name: "owner/coding-agent",
    description: "Coding agent tool",
    license: "MIT",
    readme: "Requires your paid OpenAI API key."
  });
  assert.equal(paidOnly.eligible, false);
  const ordinaryLocalApp = agentEligibility({
    name: "owner/llama-console",
    description: "Local model console",
    license: "MIT",
    readme: "Supports Ollama local model."
  });
  assert.equal(ordinaryLocalApp.eligible, false, "普通本地模型工具不能误判为 Agent");
  const noLicense = agentEligibility({
    name: "owner/research-agent",
    description: "Research agent tool",
    license: "NOASSERTION",
    readme: "Supports Ollama local model."
  });
  assert.equal(noLicense.eligible, false);
});

test("Agent 评测、榜单和报告不能误判为可用 Agent 软件", () => {
  const benchmark = agentEligibility({
    name: "owner/llm-hardtest-report",
    description: "Local-first reproducible benchmark for reasoning and coding-agent LLM evaluation",
    license: "MIT",
    readme: "Supports Ollama local models for benchmark runs."
  });
  assert.equal(benchmark.eligible, false);
  assert.equal(benchmark.isAgent, false);
});

test("Agent 推荐对低 Star 新项目保持保守", () => {
  const repo = {
    name: "owner/browser-agent",
    description: "Browser agent tool with workflow automation",
    topics: ["agent"],
    license: "MIT",
    readme: "AI agent browser workflow Ollama local model quickstart Docker 中文 Qwen",
    stars: 200
  };
  const eligibility = agentEligibility(repo);
  const score = scoreAgent(repo);
  assert.ok(score >= 60);
  assert.equal(recommendationForAgent(score, eligibility.eligible, 200), "值得安装");
  assert.equal(recommendationForAgent(100, true, 3), "继续观察");
  assert.equal(recommendationForAgent(100, false, 1000), "不符合免费标准");
});

test("replacementDecision 单次失败只要求复测，不直接建议替换", () => {
  const transient = replacementDecision({ currentHealthy: false, currentMissing: false });
  assert.equal(transient.level, "需要复测");
  assert.ok(transient.recommendation.includes("单次失败") || transient.recommendation.includes("先复测"));
});

test("replacementDecision 新免费模型也不会自动替换生产模型", () => {
  const decision = replacementDecision({
    currentHealthy: true,
    newCandidates: [{ model: "new", freeLevel: "A", probeOk: true }]
  });
  assert.equal(decision.level, "继续观察");
  assert.ok(decision.recommendation.includes("不自动替换"));
});

test("changedHashes 首次基线不报变化", () => {
  assert.equal(changedHashes([], ["a"]), false);
  assert.equal(changedHashes(["a"], ["b"]), true);
});

test("日报包含供应商、免费 API、Agent、风险和人工确认规则", () => {
  const provider = { name: "groq", displayName: "Groq", model: "m1" };
  const report = buildReport({
    providerResults: [{
      provider,
      probe: { ok: true, status: "ok", latencyMs: 100, jsonOk: true },
      models: { ok: true, status: "ok", ids: ["m1"] },
      diff: { added: [], removed: [], currentMissing: false },
      watchChanged: false,
      newCandidates: [],
      decision: replacementDecision({ currentHealthy: true })
    }],
    watchOnlyResults: [],
    apiLeads: [],
    agents: [],
    sourceErrors: []
  });
  for (const section of ["【今日结论】", "【现有供应商变化】", "【新发现免费 API 线索】", "【新发现免费 Agent】", "【风险与未确认】", "【今天需要做什么】"]) {
    assert.ok(report.includes(section), `缺少 ${section}`);
  }
  assert.ok(report.includes("不会自动改动"));
});
