// 只把公开 Actions 运行元数据收成学习事件。
// 允许字段：仓库、工作流名、结论、时间、运行号、公开提交、事件类型、公开链接。
// 日志、密钥、邮箱、正文一律丢弃。结论不是根因，rootCauseVerified 永远为 false。

const ALLOWED = ["repository", "name", "conclusion", "createdAt", "databaseId", "headSha", "event", "url"];
const SECRET = /sk-|gsk_|ghp_|gho_|nvap|AQ\.|api[_-]?key|token|password|@/i;

export function sanitizeRun(run) {
  if (!run || typeof run !== "object") return { ok: false, reason: "not_an_object" };
  for (const key of Object.keys(run)) {
    if (!ALLOWED.includes(key)) return { ok: false, reason: `field_dropped:${key}` };
  }
  for (const key of ["name", "conclusion", "url", "headSha", "event"]) {
    if (SECRET.test(String(run[key] || ""))) return { ok: false, reason: "sensitive_pattern" };
  }
  if (!run.databaseId || !run.createdAt || !run.name || !run.conclusion || !run.url) {
    return { ok: false, reason: "missing_public_fields" };
  }
  const signal = run.conclusion === "success" ? "high_value_success" : "failure_correction";
  return {
    ok: true,
    event: {
      source: "github-actions-public-metadata",
      occurredAt: run.createdAt,
      project: "github-ai-executor",
      signal,
      outcome: `${run.name} ${run.conclusion} (${run.event})`,
      evidence: String(run.url),
      rootCauseVerified: false,
      scope: run.name,
      status: "pending_verification",
      dedupeKey: `actions:${run.databaseId}`,
    },
  };
}

export function sanitizeRuns(runs) {
  const events = [];
  const rejected = [];
  for (const run of runs || []) {
    const result = sanitizeRun(run);
    if (result.ok) events.push(result.event);
    else rejected.push({ id: run?.databaseId || null, reason: result.reason });
  }
  return { events, rejected };
}
