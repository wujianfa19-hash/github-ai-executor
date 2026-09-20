import { normalizeUrl } from "./core.mjs";

const UA = "net-venture-radar/1.3 (+GitHub Actions; conservative public-source research)";

async function fetchWithTimeout(url, options = {}, timeoutMs = 12_000) {
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

export async function fetchJson(url, options = {}, timeoutMs = 12_000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

export async function fetchText(url, options = {}, timeoutMs = 12_000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const type = res.headers.get("content-type") || "";
  if (/image|audio|video|application\/(zip|octet-stream)/i.test(type)) throw new Error(`Unsupported content-type: ${type}`);
  const text = await res.text();
  return text.slice(0, 240_000);
}

function isoFromUnix(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

export async function collectGitHub({ token, queries, lookbackHours = 168, max = 60 }) {
  const since = new Date(Date.now() - lookbackHours * 3_600_000).toISOString().slice(0, 10);
  const headers = token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" };
  const all = [];
  for (const q of queries) {
    if (all.length >= max) break;
    const query = `${q} created:>=${since} stars:>1`;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=15`;
    try {
      const data = await fetchJson(url, { headers });
      for (const repo of data.items || []) {
        all.push({
          source: "github",
          name: repo.full_name,
          title: repo.full_name,
          description: repo.description || "",
          url: repo.html_url,
          homepage: repo.homepage || "",
          sourceUrl: repo.html_url,
          githubFullName: repo.full_name,
          createdAt: repo.created_at,
          publishedAt: repo.created_at,
          updatedAt: repo.updated_at,
          stars: repo.stargazers_count || 0,
          forks: repo.forks_count || 0,
          language: repo.language || "",
          topics: repo.topics || []
        });
        if (all.length >= max) break;
      }
    } catch (error) {
      all.push({ source: "source_error", sourceName: "github", error: String(error.message || error) });
    }
  }
  return all;
}

export async function collectHackerNews({ queries, lookbackHours = 168, max = 60 }) {
  const minTs = Math.floor((Date.now() - lookbackHours * 3_600_000) / 1000);
  const all = [];
  for (const q of queries) {
    if (all.length >= max) break;
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${minTs}&hitsPerPage=20`;
    try {
      const data = await fetchJson(url);
      for (const hit of data.hits || []) {
        const target = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
        all.push({
          source: "hacker_news",
          name: hit.title || "HN story",
          title: hit.title || "HN story",
          description: hit.story_text ? String(hit.story_text).replace(/<[^>]+>/g, " ").slice(0, 1000) : "",
          url: target,
          sourceUrl: target,
          discussionUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          publishedAt: hit.created_at || isoFromUnix(hit.created_at_i),
          points: hit.points || 0,
          comments: hit.num_comments || 0,
          hnObjectId: hit.objectID
        });
        if (all.length >= max) break;
      }
    } catch (error) {
      all.push({ source: "source_error", sourceName: "hacker_news", error: String(error.message || error) });
    }
  }
  return all;
}

export async function collectBraveSearch({ apiKey, queries, max = 30 }) {
  if (!apiKey) return [];
  const all = [];
  for (const q of queries) {
    if (all.length >= max) break;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=10&freshness=pw`;
    try {
      const data = await fetchJson(url, { headers: { "X-Subscription-Token": apiKey, Accept: "application/json" } });
      for (const r of data.web?.results || []) {
        all.push({
          source: "brave_search",
          name: r.title,
          title: r.title,
          description: r.description || "",
          url: r.url,
          sourceUrl: r.url,
          publishedAt: r.age ? new Date().toISOString() : null
        });
        if (all.length >= max) break;
      }
    } catch (error) {
      all.push({ source: "source_error", sourceName: "brave_search", error: String(error.message || error) });
    }
  }
  return all;
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

export async function fetchEvidencePages(candidate, { githubToken, braveApiKey, maxPages = 5 } = {}) {
  const sources = [];
  const errors = [];
  const pushText = (kind, url, text, official = false) => {
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, 14_000);
    if (clean.length >= 80) sources.push({ kind, url: normalizeUrl(url), official, text: clean });
  };

  if (candidate.githubFullName) {
    try {
      const headers = githubToken ? { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github.raw+json" } : { Accept: "application/vnd.github.raw+json" };
      const readmeUrl = `https://api.github.com/repos/${candidate.githubFullName}/readme`;
      const res = await fetchWithTimeout(readmeUrl, { headers });
      if (res.ok) pushText("github_readme", candidate.url, await res.text(), true);
    } catch (error) {
      errors.push(`GitHub README: ${error.message || error}`);
    }
  }

  for (const url of [candidate.homepage, candidate.url, candidate.discussionUrl].filter(Boolean)) {
    if (sources.length >= maxPages) break;
    if (candidate.githubFullName && normalizeUrl(url) === normalizeUrl(candidate.url)) continue;
    try {
      const html = await fetchText(url);
      pushText(url === candidate.discussionUrl ? "community_discussion" : "web_page", url, htmlToText(html), url !== candidate.discussionUrl);
    } catch (error) {
      errors.push(`${url}: ${error.message || error}`);
    }
  }

  if (braveApiKey && sources.length < maxPages) {
    const name = candidate.name || candidate.title;
    const q = `${name} supported countries China KYC payout withdrawal affiliate creator payment`;
    try {
      const data = await fetchJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=8`, {
        headers: { "X-Subscription-Token": braveApiKey, Accept: "application/json" }
      });
      for (const r of data.web?.results || []) {
        if (sources.length >= maxPages) break;
        try {
          const html = await fetchText(r.url, {}, 10_000);
          const host = new URL(r.url).hostname.replace(/^www\./, "");
          let officialHost = "";
          try { officialHost = new URL(candidate.homepage || candidate.url).hostname.replace(/^www\./, ""); } catch {}
          pushText("search_evidence", r.url, htmlToText(html), officialHost && host.endsWith(officialHost));
        } catch {}
      }
    } catch (error) {
      errors.push(`Brave verify: ${error.message || error}`);
    }
  }

  return { sources, errors };
}

function extractJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error("Model did not return valid JSON");
}

export async function analyzeWithDeepSeek(candidate, evidence, { apiKey, model = "deepseek-chat", skillExcerpt = "" } = {}) {
  if (!apiKey) return null;
  const evidenceText = evidence.sources.map((s, i) => `SOURCE ${i + 1} [${s.kind}] ${s.url}\n${s.text}`).join("\n\n").slice(0, 45_000);
  const system = `你是“网创新项目雷达”的事实核验器。严格区分事实与推断。未知必须输出 unknown/unconfirmed，不得猜测中国大陆支持、KYC、提现、佣金、到账案例。不得建议虚假身份、绕地域限制、借用KYC或其他规避风控做法。只输出 JSON，不要 Markdown。${skillExcerpt ? `\n规则摘要：${skillExcerpt.slice(0, 6000)}` : ""}`;
  const user = `候选项目：\n${JSON.stringify({
    project_id: candidate.projectId,
    name: candidate.name || candidate.title,
    url: candidate.url,
    description: candidate.description,
    published_at: candidate.publishedAt,
    source_signals: candidate.sourceSignals,
    stars: candidate.stars,
    points: candidate.points,
    comments: candidate.comments
  })}\n\n已抓取证据：\n${evidenceText || "无可用正文证据"}\n\n请返回严格 JSON，字段必须齐全：
{
  "summary":"1-2句",
  "why_now":"1-2句",
  "monetization_paths":["最多3条"],
  "monetization_type":"A|B|C|D",
  "first_money_loop":"入口→动作→转化条件→谁付钱→怎么结算→如何到账；不清楚写尚未验证",
  "first_money_loop_status":"confirmed|unconfirmed",
  "seven_day_test":["4-7步低成本动作"],
  "thresholds":{"funding":"低|中|高","skills":"","geo_account":"","existing_traffic":"需要|不需要|未知"},
  "facts":{
    "launch_status":"confirmed|unconfirmed",
    "mainland_registration":"supported|conditional|unsupported|unknown|conflicting",
    "kyc_status":"supported|conditional|unsupported|not_required|unknown|conflicting",
    "mainland_mobile":"supported|unsupported|not_applicable|unknown",
    "payout_status":"confirmed|conditional|unsupported|unknown|conflicting",
    "mainland_payout":"supported|conditional|unsupported|unknown|conflicting",
    "payout_methods":[""],
    "settlement_details":"",
    "tax_company_requirements":"",
    "recent_payout_cases":[{"date":"YYYY-MM-DD或unknown","url":"","method":"","evidence_type":"","cross_verified":false}],
    "risk_evidence_status":"confirmed|none_found|unknown",
    "risks":[""]
  },
  "scores":{
    "freshness":0,
    "monetization_clarity":0,
    "participation":0,
    "demand_bonus":0,
    "information_gap":0,
    "opportunity_score":0,
    "urgency_score":0,
    "long_term_score":0
  },
  "long_term_reason":"",
  "today_action":"只给一个最小动作",
  "confidence_notes":"",
  "source_urls":["只列证据中实际出现的URL"]
}
机会评分按100分制：新鲜度30、变现25、普通人参与15、需求红利15、信息差15。urgency_score/long_term_score 为0-100。不要为了凑分而乐观。`;
  const response = await fetchWithTimeout("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: user }]
    })
  }, 45_000);
  if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  const data = await response.json();
  return extractJsonObject(data.choices?.[0]?.message?.content || "");
}

export async function refreshGmailAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return (await res.json()).access_token;
}

function markdownToHtml(markdown) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(markdown).split(/\r?\n/).map((line) => {
    if (line.startsWith("# ")) return `<h1>${esc(line.slice(2))}</h1>`;
    if (line.startsWith("## ")) return `<h2>${esc(line.slice(3))}</h2>`;
    if (line.startsWith("### ")) return `<h3>${esc(line.slice(4))}</h3>`;
    if (line.startsWith("- ")) return `<div>• ${esc(line.slice(2))}</div>`;
    if (!line.trim()) return "<br>";
    return `<div>${esc(line).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")}</div>`;
  }).join("\n");
}

export async function sendGmail({ markdown, subject, from, to, clientId, clientSecret, refreshToken }) {
  const accessToken = await refreshGmailAccessToken({ clientId, clientSecret, refreshToken });
  const boundary = `net-venture-radar-${Date.now().toString(36)}`;
  const html = markdownToHtml(markdown);
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
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
    `<div style=\"max-width:900px;margin:auto;padding:20px;font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;color:#222\">${html}</div>`,
    "",
    `--${boundary}--`
  ].join("\r\n");
  const raw = Buffer.from(message).toString("base64url");
  const res = await fetchWithTimeout("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw })
  }, 20_000);
  if (!res.ok) throw new Error(`Gmail send failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.json();
}
