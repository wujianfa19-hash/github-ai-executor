import fs from "node:fs";

const LEGACY_DEEPSEEK_ENDPOINTS = new Set([
  "https://api.deepseek.com/chat/completions",
  "https://api.deepseek.com/v1/chat/completions"
]);

const registry = JSON.parse(fs.readFileSync(new URL("./free-model-registry.json", import.meta.url), "utf8"));
if (!registry?.policy?.freeOnly || !registry?.policy?.oneModelPerProvider) {
  throw new Error("free-model-registry.json policy invalid: freeOnly and oneModelPerProvider must be true");
}
const PROVIDERS = Array.isArray(registry.providers) ? registry.providers : [];
if (!PROVIDERS.length) throw new Error("free-model-registry.json has no providers");

// 旧业务代码仍用 DEEPSEEK_KEY 判断“是否启用模型”。这里放的只是固定哨兵，
// 不是任何真实 API Key；所有真实请求都由本路由器改发到注册表里的免费模型供应商。
process.env.DEEPSEEK_KEY = "__FREE_MODEL_ROUTER_ENABLED__";
process.env.DEEPSEEK_MODEL = "multi-free-router";

const nativeFetch = globalThis.fetch.bind(globalThis);
const unhealthyUntil = new Map();
const COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 22_000;

function isLegacyDeepSeekUrl(input) {
  const url = typeof input === "string" ? input : input?.url;
  if (!url) return false;
  return LEGACY_DEEPSEEK_ENDPOINTS.has(String(url).replace(/\/+$/, ""));
}

function parseJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function messagesForGemini(messages) {
  const system = messages.filter((m) => m?.role === "system").map((m) => String(m.content || "")).join("\n\n");
  const contents = messages
    .filter((m) => m?.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }]
    }));
  return { system, contents: contents.length ? contents : [{ role: "user", parts: [{ text: "请按要求返回 JSON。" }] }] };
}

function safeHeaders(provider, key) {
  if (provider.type === "gemini") {
    return { "x-goog-api-key": key, "Content-Type": "application/json" };
  }
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function providerBody(provider, legacyBody) {
  const messages = Array.isArray(legacyBody?.messages) ? legacyBody.messages : [];
  const maxTokens = Math.max(256, Math.min(Number(legacyBody?.max_tokens || 5000), 9000));
  if (provider.type === "gemini") {
    const { system, contents } = messagesForGemini(messages);
    return JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: maxTokens,
        temperature: Math.min(Number(legacyBody?.temperature ?? 0.2), 0.7)
      }
    });
  }
  const temperature = provider.temperature ?? Math.min(Number(legacyBody?.temperature ?? 0.2), 0.7);
  return JSON.stringify({
    model: provider.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
    ...(provider.extra || {})
  });
}

function extractProviderContent(provider, data) {
  if (provider.type === "gemini") {
    return (data?.candidates?.[0]?.content?.parts || []).map((part) => part?.text || "").join("").trim();
  }
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function normalizedSuccess(content, provider) {
  return new Response(JSON.stringify({
    id: `free-router-${Date.now()}`,
    object: "chat.completion",
    model: provider.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    router: { provider: provider.name, model: provider.model, free_only: true }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", "X-AI-Router-Provider": provider.name }
  });
}

function shouldCooldown(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

async function callProvider(provider, legacyBody, outerSignal) {
  const key = process.env[provider.env] || "";
  if (!key) return { ok: false, skip: true, reason: "missing_secret" };
  const until = unhealthyUntil.get(provider.name) || 0;
  if (until > Date.now()) return { ok: false, skip: true, reason: "cooldown" };
  if (outerSignal?.aborted) return { ok: false, skip: true, reason: "outer_aborted" };

  const controller = new AbortController();
  const timeoutMs = Number(provider.timeoutMs || process.env.FREE_MODEL_ROUTER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromOuter = () => controller.abort();
  outerSignal?.addEventListener?.("abort", abortFromOuter, { once: true });
  const started = Date.now();
  try {
    const response = await nativeFetch(provider.endpoint, {
      method: "POST",
      headers: safeHeaders(provider, key),
      body: providerBody(provider, legacyBody),
      signal: controller.signal
    });
    const latency = Date.now() - started;
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 180);
      if (shouldCooldown(response.status)) unhealthyUntil.set(provider.name, Date.now() + COOLDOWN_MS);
      console.warn(`AI_ROUTER provider=${provider.name} model=${provider.model} status=http_${response.status} latency_ms=${latency} detail=${detail}`);
      return { ok: false, reason: `http_${response.status}` };
    }
    const data = await response.json();
    const content = extractProviderContent(provider, data);
    if (!content || !parseJsonObject(content)) {
      console.warn(`AI_ROUTER provider=${provider.name} model=${provider.model} status=invalid_json latency_ms=${latency}`);
      return { ok: false, reason: "invalid_json" };
    }
    console.log(`AI_ROUTER provider=${provider.name} model=${provider.model} status=success latency_ms=${latency}`);
    return { ok: true, content };
  } catch (error) {
    const latency = Date.now() - started;
    const reason = error?.name === "AbortError" ? "timeout" : "network_error";
    unhealthyUntil.set(provider.name, Date.now() + COOLDOWN_MS);
    console.warn(`AI_ROUTER provider=${provider.name} model=${provider.model} status=${reason} latency_ms=${latency}`);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener?.("abort", abortFromOuter);
  }
}

async function routeLegacyDeepSeekRequest(init = {}) {
  let legacyBody = {};
  try {
    legacyBody = typeof init.body === "string" ? JSON.parse(init.body) : (init.body || {});
  } catch {
    return new Response(JSON.stringify({ error: { message: "FREE_MODEL_ROUTER invalid legacy request body" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const available = PROVIDERS.filter((p) => Boolean(process.env[p.env]));
  console.log(`AI_ROUTER free_only=true configured=${available.length} order=${available.map((p) => p.name).join(",") || "none"}`);
  const failures = [];
  for (const provider of PROVIDERS) {
    if (init.signal?.aborted) break;
    const result = await callProvider(provider, legacyBody, init.signal);
    if (result.ok) return normalizedSuccess(result.content, provider);
    if (!result.skip) failures.push(`${provider.name}:${result.reason}`);
  }

  return new Response(JSON.stringify({
    error: {
      message: `FREE_MODEL_ROUTER all providers failed (${failures.join(", ") || "no configured provider"})`
    }
  }), {
    status: 503,
    headers: { "Content-Type": "application/json" }
  });
}

globalThis.fetch = async function freeModelRouterFetch(input, init = {}) {
  if (isLegacyDeepSeekUrl(input)) return routeLegacyDeepSeekRequest(init);
  return nativeFetch(input, init);
};

export { PROVIDERS, parseJsonObject, routeLegacyDeepSeekRequest };
