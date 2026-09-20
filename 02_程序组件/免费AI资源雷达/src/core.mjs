export function normalizeModelIds(data, providerType = "openai") {
  if (providerType === "gemini") {
    return [...new Set((data?.models || [])
      .map((m) => String(m?.name || "").replace(/^models\//, "").trim())
      .filter(Boolean))].sort();
  }
  return [...new Set((data?.data || data?.models || [])
    .map((m) => String(m?.id || m?.name || "").trim())
    .filter(Boolean))].sort();
}

export function diffModels(previous = [], current = [], currentModel = "") {
  const prev = new Set(previous || []);
  const now = new Set(current || []);
  return {
    added: [...now].filter((id) => !prev.has(id)).sort(),
    removed: [...prev].filter((id) => !now.has(id)).sort(),
    currentMissing: Boolean(currentModel && current.length && !now.has(currentModel))
  };
}

export function freeLevelFromEvidence({ modelId = "", text = "" } = {}) {
  const id = String(modelId || "");
  const body = String(text || "").toLowerCase();
  if (/:free$/i.test(id)) return { level: "A", reason: "模型 ID 明确标记为 :free" };

  const needle = id.toLowerCase();
  const at = needle ? body.indexOf(needle) : -1;
  const nearby = at >= 0 ? body.slice(Math.max(0, at - 600), at + needle.length + 900) : body.slice(0, 3000);
  if (/(trial|试用|signup credit|注册.*额度|赠送.*额度|one[- ]time|限时)/i.test(nearby)) {
    return { level: "C", reason: "证据更像一次性试用或限时赠送额度" };
  }
  if (/(credit card|绑卡|地区|region|limited free|free quota|免费额度很小|每月.*免费)/i.test(nearby)) {
    return { level: "B", reason: "存在免费额度，但带有条件或明显限制" };
  }
  if (/(free tier|free model|free api|免费模型|永久免费|免费调用|价格\s*[:：]?\s*0|\$0(?:\.00)?)/i.test(nearby)) {
    return { level: "A", reason: "官方页面附近出现持续免费或零价格证据" };
  }
  return { level: "unknown", reason: "尚未找到足够的官方免费证据" };
}

const FREE_MODEL_PATTERNS = [
  /\bollama\b/i,
  /llama\.cpp/i,
  /\bgguf\b/i,
  /local\s+(?:llm|model)/i,
  /本地(?:大模型|模型)/i,
  /openrouter[^\n]{0,100}:free/i,
  /free\s+tier[^\n]{0,120}(?:gemini|groq|model|api)/i,
  /(?:gemini|groq)[^\n]{0,120}free/i,
  /qwen[^\n]{0,80}(?:ollama|local)/i,
  /llama[^\n]{0,80}(?:ollama|local)/i,
  /mistral[^\n]{0,80}(?:ollama|local)/i
];

function agentIdentitySignal(repo = {}) {
  const identity = [repo.name, repo.title, repo.description].filter(Boolean).join(" ");
  const negative = /\b(benchmark|evaluation|evals?|leaderboard|dataset|report|test(?:ing)? suite|hardtest)\b/i.test(identity);
  const explicit = /\b(?:ai|coding|browser|research|desktop|computer[- ]use|autonomous|workflow)\s*[- ]?agent\b|\bagent\s+(?:that|for|to|with|framework|platform|tool|assistant|runner)\b|智能体/i.test(identity);
  const productLike = /\b(framework|platform|assistant|automation|workbench|tool|runner|browser|coding|research|computer use|read, write|execute|run code)\b/i.test(identity);
  if (negative && !/\bagent\s+(?:framework|platform|tool|assistant|runner)\b/i.test(identity)) return false;
  return explicit && productLike;
}

export function agentEligibility(repo = {}) {
  const license = String(repo.license || repo.licenseSpdx || "").trim();
  const readme = String(repo.readme || repo.readmePreview || "");
  const isAgent = agentIdentitySignal(repo);
  const softwareFree = Boolean(license && !/NOASSERTION|proprietary|commercial/i.test(license));
  const matched = FREE_MODEL_PATTERNS.find((pattern) => pattern.test(readme));
  const freeModelPath = Boolean(matched);
  return {
    eligible: isAgent && softwareFree && freeModelPath,
    isAgent,
    softwareFree,
    freeModelPath,
    reason: !isAgent
      ? "没有足够证据确认它本身就是可执行任务的 Agent 软件，而不是评测、报告或普通模型工具"
      : !softwareFree
        ? "没有确认到明确的免费开源许可证"
        : !freeModelPath
          ? "软件本身可免费获取，但没有确认到无需付费模型即可使用的路径"
          : "已确认是 Agent 软件、软件免费，并在项目说明中找到本地模型或免费模型使用路径"
  };
}

export function replacementDecision({ currentHealthy = true, currentMissing = false, newCandidates = [] } = {}) {
  if (currentMissing) {
    return {
      level: "需要处理",
      recommendation: "当前生产模型在模型列表中消失且直接调用也不可用；应尽快核验替代，但仍需人工确认后再改生产配置。"
    };
  }
  if (!currentHealthy) {
    return {
      level: "需要复测",
      recommendation: "当前最小调用暂时失败，可能是限流、繁忙或网络波动；先复测，不因单次失败直接替换生产模型。"
    };
  }
  const verifiedA = (newCandidates || []).filter((c) => c.freeLevel === "A" && c.probeOk);
  if (verifiedA.length) {
    return {
      level: "继续观察",
      recommendation: `发现 ${verifiedA.length} 个通过最小调用且有 A 级免费证据的新模型；先做同任务对比与稳定性观察，不自动替换生产模型。`
    };
  }
  return { level: "保持现状", recommendation: "暂无足够证据证明新模型更适合替换当前生产免费模型。" };
}

export function scoreAgent(repo = {}) {
  const eligibility = agentEligibility(repo);
  let score = 0;
  score += eligibility.isAgent ? 20 : 0;
  score += eligibility.softwareFree ? 25 : 0;
  score += eligibility.freeModelPath ? 20 : 0;
  const text = `${repo.description || ""} ${repo.readme || ""}`;
  if (/(browser|coding|research|computer use|workflow|tool calling)/i.test(text)) score += 12;
  if (/(quickstart|install|docker|pip install|npm install|one[- ]click)/i.test(text)) score += 8;
  if (/(中文|chinese|qwen|glm|deepseek)/i.test(text)) score += 5;
  if ((repo.stars || 0) >= 100) score += 5;
  if ((repo.stars || 0) >= 500) score += 3;
  if (/(local|ollama|llama\.cpp)/i.test(text)) score += 2;
  return Math.max(0, Math.min(100, score));
}

export function recommendationForAgent(score, eligible, stars = 0) {
  if (!eligible) return "不符合免费标准";
  if (score >= 85 && stars >= 100) return "值得安装";
  if (score >= 65 && stars >= 10) return "可以试试";
  return "继续观察";
}

export function dedupeByUrl(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = String(item.url || item.sourceUrl || item.name || "").toLowerCase().replace(/\/$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
