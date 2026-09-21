// 自我升级核心决策引擎（阶段 E 最小版本，纯逻辑、可测、不产生实际写入）
// 闭环：候选改进 → 边界分类 → 固定测试 → 不低于旧版 → 采用（写临时结果）
//      任意失败 → 丢弃候选 + 保留失败记录。
import { canAutoApply } from "./categories.mjs";
import { scenario } from "./fixed-tests.mjs";

// 评估一个候选。返回结构化决策，绝不直接写永久大脑。
// input = {
//   tag, // 内容类别（切成允许/禁止）
//   oldContent, newContent,
//   latestDecision, staleRules, sourceContent, project, conflict, isSuggestionOnly,
// }
export function evaluateCandidate(input) {
  const record = {
    tag: input.tag,
    decidedAt: new Date().toISOString(),
    passed: false,
    checks: {},
    failures: [],
    adoptedContent: null,
  };

  // 1) 边界：禁止的类别绝不自动采用。
  const boundary = canAutoApply(input.tag);
  if (!boundary.ok) {
    record.failures.push(`boundary:${boundary.reason}`);
    return record;
  }

  // 2) 固定测试。
  const ctx = {
    oldContent: input.oldContent,
    newContent: input.newContent,
    latestDecision: input.latestDecision,
    staleRules: input.staleRules || [],
    sourceContent: input.sourceContent,
    project: input.project,
    conflict: input.conflict,
    isSuggestionOnly: input.isSuggestionOnly,
  };
  const checks = scenario();
  for (const check of checks) {
    const result = check.fn(ctx);
    record.checks[check.id] = result;
    if (!result.ok) record.failures.push(`${check.id}:${result.note}`);
  }

  // 3) 全部通过才采用（写临时结果，供上层决定是否落盘正式内容）。
  if (record.failures.length === 0) {
    record.passed = true;
    record.adoptedContent = input.newContent;
  }

  return record;
}

// 供固定测试用的分类断言导出
export { canAutoApply, classify } from "./categories.mjs";
export { scenario } from "./fixed-tests.mjs";