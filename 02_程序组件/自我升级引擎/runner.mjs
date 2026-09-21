// 自我升级 runner：把"候选改进"喂给受控引擎，输出决策，不直接写永久大脑。
//
// 用法：
//   node 02_程序组件/自我升级引擎/runner.mjs <candidate.json>
//
// candidate.json 字段（与 engine.evaluateCandidate 的 input 对齐）：
//   {
//     "tag": "derived_summary" | "index" | ...  // 允许类别
//     "oldContent": "旧派生内容",
//     "newContent": "候选派生内容",
//     "latestDecision": "最新已确认决定(需保留)",
//     "staleRules": ["已废弃规则关键词"],
//     "sourceContent": "用户原意/源原文引用",
//     "project": "项目标记",
//     "conflict": false,
//     "isSuggestionOnly": false
//   }
//
// 输出：JSON 决策（含 passed、checks、failures、adoptedContent）。
// adoptedContent 仅在 passed=true 时由调用方决定落盘；engine/runner 自身绝不写永久大脑。
import { readFileSync } from "node:fs";
import { evaluateCandidate } from "./engine.mjs";

const [, , candidatePath] = process.argv;
if (!candidatePath) {
  console.error("usage: node runner.mjs <candidate.json>");
  process.exit(2);
}
let input;
try {
  input = JSON.parse(readFileSync(candidatePath, "utf8"));
} catch (error) {
  console.error(`CANDIDATE_PARSE_FAILED ${error.message}`);
  process.exit(2);
}

const record = evaluateCandidate(input);
process.stdout.write(JSON.stringify(record, null, 2) + "\n");
// 退出码：0=已采纳，1=被拒绝/失败（供上层区分，不代表执行失败）
process.exit(record.passed ? 0 : 1);