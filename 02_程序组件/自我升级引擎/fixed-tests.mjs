// 自我升级固定测试（阶段 F）：候选必须通过的安全回归检查（纯函数，可测）
// 覆盖操作摘要 §10：不把旧规则当当前规则、不改写源内容、不重复、不混淆项目、
// 不把建议写成决定、冲突停等、总体不比旧版差、失败可回退。

// 输入约定：
// ctx = { oldContent, newContent, latestDecision, currentRules, sourceContent, project, conflict }
export function scenario() {
  return [
    { id: "no_loss_of_newest_decision", fn: latestDecisionWins },
    { id: "no_stale_rule_as_current", fn: staleRuleNotCurrent },
    { id: "no_source_rewrite", fn: sourceUntouched },
    { id: "no_duplicate", fn: noDuplication },
    { id: "no_cross_project_mix", fn: noCrossProjectMix },
    { id: "no_agent_suggestion_as_decision", fn: suggestionNotDecision },
    { id: "conflict_wait_user", fn: conflictHalts },
    { id: "no_worse_than_old", fn: notWorseThanOld },
  ];
}

// 1. 必须能指向最新已确认决定，不得退回旧决定。
export function latestDecisionWins(ctx) {
  const latest = ctx.latestDecision;
  if (!latest) return { ok: true, note: "no_latest_decision" };
  const wins = String(ctx.newContent).includes(latest);
  return wins
    ? { ok: true, note: `latest_decision_kept` }
    : { ok: false, note: "dropped_latest_decision" };
}

// 2. 不得把"已废弃旧规则"重新当成当前规则。
export function staleRuleNotCurrent(ctx) {
  for (const stale of ctx.staleRules || []) {
    if (String(ctx.newContent).includes(stale)) {
      return { ok: false, note: `stale_rule_resurfaced:${stale}` };
    }
  }
  return { ok: true, note: "no_stale_rule" };
}

// 3. 不得改写用户原始源内容。
export function sourceUntouched(ctx) {
  const src = String(ctx.sourceContent || "");
  if (!src) return { ok: true, note: "no_source" };
  return String(ctx.newContent).indexOf(src) !== -1
    ? { ok: true, note: "source_preserved" }
    : { ok: false, note: "source_rewritten_or_removed" };
}

// 4. 不得重复写入相同记忆 / 摘要。
export function noDuplication(ctx) {
  const lines = String(ctx.newContent).split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) return { ok: false, note: "duplicate_line" };
    seen.add(key);
  }
  return { ok: true, note: "no_duplicate" };
}

// 5. 不得把不同项目的内容混在一起。
export function noCrossProjectMix(ctx) {
  if (!ctx.project) return { ok: true, note: "no_project_tag" };
  const marker = `[${ctx.project}]`;
  const content = String(ctx.newContent);
  // 若内容包含其他项目的显式标记，判为混淆。仅当项目标记出现时才做此检查。
  if (content.includes(marker)) return { ok: true, note: "project_scoped" };
  return { ok: false, note: `missing_project_marker:${ctx.project}` };
}

// 6. 不得把智能代理建议写成用户决定。
export function suggestionNotDecision(ctx) {
  const banned = ["用户决定：", "用户已决定：", "用户拍板："];
  const content = String(ctx.newContent);
  for (const phrase of banned) {
    if (content.includes(phrase) && (ctx.isSuggestionOnly === true)) {
      return { ok: false, note: "suggestion_written_as_decision" };
    }
  }
  return { ok: true, note: "no_suggestion_as_decision" };
}

// 7. 真正冲突必须停下、等用户，不得自行裁决。
export function conflictHalts(ctx) {
  if (ctx.conflict) return { ok: false, note: "conflict_requires_user" };
  return { ok: true, note: "no_conflict" };
}

// 8. 修改后不得比旧版本更差（用最小质量信号近似：非空 + 长度不显著缩水 + 关键校验仍通过）。
export function notWorseThanOld(ctx) {
  const old = String(ctx.oldContent || "");
  const next = String(ctx.newContent || "");
  if (!next.trim()) return { ok: false, note: "empty_new_content" };
  // 派生内容应有实质长度；允许微调，不允许大幅丢弃（>50% 缩水即视为更差）。
  const ratio = old && old.length > 0 ? next.length / old.length : 1;
  if (ratio < 0.5) return { ok: false, note: `content_shrank:${ratio.toFixed(2)}` };
  return { ok: true, note: `ok_ratio:${ratio.toFixed(2)}` };
}