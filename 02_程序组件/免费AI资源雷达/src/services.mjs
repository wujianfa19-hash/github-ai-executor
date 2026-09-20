import crypto from "node:crypto";

const UA = "free-ai-resource-radar/1.0 (+GitHub Actions; free-only evidence monitor)";

export async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "User-Agent": UA, Accept: "application/json,text/html;q=0.9,*/*;q=0.8", ...(options.headers || {}) }
    });
  } finally {
    clearTimeout(timer);
  }
}

export function textHash(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex").slice(0, 20);
}

export function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function providerHeaders(provider, key) {
  if (provider.type === "gemini") return { "x-goog-api-key": key, "Content-Type": "application/json" };
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function endpointForModel(provider, model) {
  if (provider.type !== "gemini") return provider.endpoint;
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

function probeBody(provider, model) {
  const prompt = "只输出 JSON，不要 Markdown：{\"ok\":true,\"language\":\"zh-CN\"}";
  if (provider.type === "gemini") {
    return JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 128, temperature: 0.1 }
    });
  }
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    temperature: provider.temperature ?? 0.1,
    max_tokens: 128,
    stream: false,
    ...(provider.extra || {})
  });
}

function extractProbeText(provider, data) {
  if (provider.type === "gemini") {
    return (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("");
  }
  return String(data?.choices?.[0]?.message?.content || "");
}

function parsedOk(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return false;
  try { return JSON.parse(raw.slice(start, end + 1))?.ok === true; } catch { return false; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchProviderModels(provider) {
  const key = process.env[provider.env] || "";
  if (!key) return { ok: false, status: "missing_secret", ids: [], error: "Secret 未配置" };
  if (!provider.modelListEndpoint) return { ok: false, status: "no_endpoint", ids: [], error: "没有模型列表接口" };
  try {
    const res = await fetchWithTimeout(provider.modelListEndpoint, { headers: providerHeaders(provider, key) }, 18_000);
    const text = await res.text();
    if (!res.ok) return { ok: false, status: `http_${res.status}`, ids: [], error: text.replace(/\s+/g, " ").slice(0, 240) };
    let data;
    try { data = JSON.parse(text); } catch { return { ok: false, status: "invalid_json", ids: [], error: "模型列表返回非 JSON" }; }
    const ids = provider.type === "gemini"
      ? (data?.models || []).map((m) => String(m?.name || "").replace(/^models\//, "")).filter(Boolean)
      : (data?.data || data?.models || []).map((m) => String(m?.id || m?.name || "")).filter(Boolean);
    return { ok: true, status: "ok", ids: [...new Set(ids)].sort(), error: "" };
  } catch (error) {
    return { ok: false, status: error?.name === "AbortError" ? "timeout" : "network_error", ids: [], error: String(error?.message || error) };
  }
}

export async function probeProviderModel(provider, model = provider.model) {
  const key = process.env[provider.env] || "";
  if (!key) return { ok: false, status: "missing_secret", latencyMs: null, jsonOk: false };
  let last = { ok: false, status: "unknown", latencyMs: null, jsonOk: false };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(endpointForModel(provider, model), {
        method: "POST",
        headers: providerHeaders(provider, key),
        body: probeBody(provider, model)
      }, Number(provider.timeoutMs || 30_000));
      const latencyMs = Date.now() - started;
      const text = await res.text();
      if (!res.ok) {
        last = { ok: false, status: `http_${res.status}`, latencyMs, jsonOk: false, detail: text.replace(/\s+/g, " ").slice(0, 180) };
        if (res.status >= 400 && res.status < 500 && res.status !== 429) return last;
      } else {
        let data;
        try { data = JSON.parse(text); } catch {
          last = { ok: false, status: "invalid_response_json", latencyMs, jsonOk: false };
          if (attempt < 2) await sleep(900);
          continue;
        }
        const content = extractProbeText(provider, data).trim();
        if (!content) {
          return { ok: true, status: "ok_empty_output", latencyMs, jsonOk: false };
        }
        const jsonOk = parsedOk(content);
        return {
          ok: true,
          status: jsonOk ? "ok" : "ok_noncanonical_json",
          latencyMs,
          jsonOk
        };
      }
    } catch (error) {
      last = {
        ok: false,
        status: error?.name === "AbortError" ? "timeout" : "network_error",
        latencyMs: Date.now() - started,
        jsonOk: false
      };
    }
    if (attempt < 2) await sleep(1200);
  }
  return last;
}

export async function fetchWatchEvidence(entry) {
  const sources = [];
  const errors = [];
  for (const url of entry.watchUrls || []) {
    try {
      const res = await fetchWithTimeout(url, {}, 15_000);
      const raw = await res.text();
      if (!res.ok) {
        errors.push(`${url}: HTTP ${res.status}`);
        continue;
      }
      const text = htmlToText(raw).slice(0, 80_000);
      if (text) sources.push({ url, text, hash: textHash(text) });
    } catch (error) {
      errors.push(`${url}: ${error?.name === "AbortError" ? "timeout" : error?.message || error}`);
    }
  }
  return { sources, errors, combinedText: sources.map((s) => s.text).join("\n\n").slice(0, 120_000) };
}

async function githubRepoSearch(query, token, sinceDate, perPage = 6) {
  const q = `${query} in:name,description created:>=${sinceDate} stars:>2`;
  const headers = token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" };
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perPage}`;
  const res = await fetchWithTimeout(url, { headers }, 15_000);
  if (!res.ok) throw new Error(`GitHub Search ${res.status}`);
  return (await res.json()).items || [];
}

function repoLead(repo, kind) {
  return {
    kind,
    name: repo.full_name,
    title: repo.full_name,
    description: repo.description || "",
    url: repo.html_url,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    language: repo.language || "",
    license: repo.license?.spdx_id || "",
    topics: repo.topics || []
  };
}

export async function collectGitHubLeads({ token, queries = [], lookbackDays = 14, max = 30, kind = "api" }) {
  const sinceDate = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const out = [];
  const errors = [];
  for (const query of queries) {
    if (out.length >= max) break;
    try {
      const items = await githubRepoSearch(query, token, sinceDate, 6);
      for (const repo of items) {
        out.push(repoLead(repo, kind));
        if (out.length >= max) break;
      }
    } catch (error) {
      errors.push(`GitHub ${query}: ${error.message || error}`);
    }
  }
  return { leads: out, errors };
}

export async function enrichAgentRepos(leads, { token, max = 18 } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json" } : { Accept: "application/vnd.github.raw+json" };
  const out = [];
  for (const lead of leads.slice(0, max)) {
    let readme = "";
    try {
      const res = await fetchWithTimeout(`https://api.github.com/repos/${lead.name}/readme`, { headers }, 12_000);
      if (res.ok) readme = (await res.text()).slice(0, 35_000);
    } catch {}
    out.push({ ...lead, readme });
  }
  return out;
}

export async function collectHackerNews({ queries = [], lookbackDays = 14, max = 24 }) {
  const minTs = Math.floor((Date.now() - lookbackDays * 86_400_000) / 1000);
  const leads = [];
  const errors = [];
  for (const query of queries) {
    if (leads.length >= max) break;
    try {
      const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i>${minTs}&hitsPerPage=8`;
      const res = await fetchWithTimeout(url, {}, 12_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const hit of data.hits || []) {
        leads.push({
          kind: "public_lead",
          name: hit.title || "HN story",
          title: hit.title || "HN story",
          description: String(hit.story_text || "").replace(/<[^>]+>/g, " ").slice(0, 800),
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          discussionUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          createdAt: hit.created_at,
          points: hit.points || 0,
          comments: hit.num_comments || 0
        });
        if (leads.length >= max) break;
      }
    } catch (error) {
      errors.push(`HN ${query}: ${error.message || error}`);
    }
  }
  return { leads, errors };
}

export async function collectBraveFreeAi({ apiKey, max = 20 }) {
  if (!apiKey) return { leads: [], errors: [] };
  const queries = [
    "new free LLM API free tier 2026",
    "new free AI inference API",
    "new open source AI agent Ollama free local model"
  ];
  const leads = [];
  const errors = [];
  for (const query of queries) {
    if (leads.length >= max) break;
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&freshness=pm`;
      const res = await fetchWithTimeout(url, { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" } }, 12_000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const r of data.web?.results || []) {
        leads.push({ kind: "web_lead", name: r.title, title: r.title, description: r.description || "", url: r.url });
        if (leads.length >= max) break;
      }
    } catch (error) {
      errors.push(`Brave ${query}: ${error.message || error}`);
    }
  }
  return { leads, errors };
}

function markdownToHtml(markdown) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(markdown).split(/\r?\n/).map((line) => {
    if (line.startsWith("# ")) return `<h1>${esc(line.slice(2))}</h1>`;
    if (line.startsWith("## ")) return `<h2>${esc(line.slice(3))}</h2>`;
    if (line.startsWith("### ")) return `<h3>${esc(line.slice(4))}</h3>`;
    if (line.startsWith("- ")) return `<div>• ${esc(line.slice(2))}</div>`;
    return `<div>${esc(line) || "&nbsp;"}</div>`;
  }).join("\n");
}

function toEmailRaw({ from, to, subject, markdown }) {
  const boundary = `free-ai-radar-${Date.now().toString(36)}`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    markdown,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    `<div style="max-width:920px;margin:0 auto;padding:20px;font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.72">${markdownToHtml(markdown)}</div>`,
    "",
    `--${boundary}--`
  ].join("\r\n");
  return Buffer.from(message).toString("base64url");
}

async function refreshGmailAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, 15_000);
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}`);
  return (await res.json()).access_token;
}

export async function sendGmail({ markdown, subject, from, to, clientId, clientSecret, refreshToken }) {
  const accessToken = await refreshGmailAccessToken({ clientId, clientSecret, refreshToken });
  const raw = toEmailRaw({ from, to, subject, markdown });
  const res = await fetchWithTimeout("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw })
  }, 20_000);
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
