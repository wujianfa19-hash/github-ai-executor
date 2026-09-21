// 受控自我升级引擎：允许 / 禁止 修改的派生内容边界（纯函数，可测）
// 依据 P5 操作摘要 §9/§15：只允许自动维护低风险派生内容，
// 永久禁止自动改 用户硬规则 / 明确决定 / 源内容 / 原始证据 / 安全边界 / 重要历史 / 真正冲突结论。

// 允许自动处理的"低风险派生内容"类别
export const ALLOWED = Object.freeze({
  DERIVED_SUMMARY: "derived_summary", // 派生摘要
  INDEX: "index", // 索引
  NAVIGATION: "navigation", // 导航
  RETRIEVAL_STRATEGY: "retrieval_strategy", // 检索方式 / 策略
  DEDUPE_RULE: "dedupe_rule", // 去重 / 重复信息识别
  STALENESS_RULE: "staleness_rule", // 过时信息识别
  CANDIDATE_RULE: "candidate_rule", // 候选规则（仅建议，不生效）
  RUN_LOG: "run_log", // 运行记录
  SELF_UPDATE_LOG: "self_update_log", // 自我升级本次运行记录
});

// 永久禁止自动处理的"源内容 / 高优先级内容"
export const FORBIDDEN = Object.freeze({
  USER_RULE: "user_rule", // 用户硬规则
  USER_DECISION: "user_decision", // 用户明确决定
  SOURCE_CONTENT: "source_content", // 原始文本 / 外部原文 / 第一手内容
  ORIGINAL_EVIDENCE: "original_evidence", // 原始证据 / 原始聊天
  SECURITY_BOUNDARY: "security_boundary", // 安全与权限边界
  IMPORTANT_HISTORY: "important_history", // 重要历史删除/改写
  TRUE_CONFLICT: "true_conflict", // 真正冲突结论
});

// 标签 → 归类。未知标签一律判为 FORBIDDEN（默认保守，不自动改）。
export function classify(tag) {
  const values = Object.values(ALLOWED);
  if (values.includes(tag)) return { kind: "allowed", level: "derived", tag };
  return { kind: "forbidden", level: "protected", tag: tag || "unknown" };
}

// 决定能否自动采用某候选（仅针对低风险派生内容）。
// 永远返回布尔 + 原因；不产生任何实际写入。
export function canAutoApply(tag) {
  const c = classify(tag);
  if (c.kind === "forbidden") {
    return { ok: false, reason: `forbidden:${c.tag}` };
  }
  return { ok: true, reason: `allowed:${c.tag}` };
}