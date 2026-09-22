// 五类学习信号。与参考方案第 4 节对齐，未知信号一律拒绝入库。
export const SIGNALS = Object.freeze({
  FAILURE_CORRECTION: "failure_correction",
  RULE_PROBLEM: "rule_problem",
  REPETITIVE_WORK: "repetitive_work",
  HIGH_VALUE_SUCCESS: "high_value_success",
  INFORMATION_QUALITY: "information_quality",
});

export const SIGNAL_SET = new Set(Object.values(SIGNALS));

// 事件正文只当数据。这些字段即使出现，也不得被当成可执行指令。
const INSTRUCTION_KEYS = ["command", "shell", "exec", "eval", "script"];

export function assertEventShape(event) {
  const missing = [];
  for (const key of ["source", "occurredAt", "project", "signal", "outcome", "dedupeKey"]) {
    if (event?.[key] === undefined || event?.[key] === null || String(event[key]).trim() === "") {
      missing.push(key);
    }
  }
  if (missing.length) return { ok: false, reason: `missing:${missing.join(",")}` };
  if (!SIGNAL_SET.has(event.signal)) return { ok: false, reason: `unknown_signal:${event.signal}` };
  if (Number.isNaN(Date.parse(event.occurredAt))) return { ok: false, reason: "bad_time" };
  for (const key of INSTRUCTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(event, key)) {
      return { ok: false, reason: `instruction_field_rejected:${key}` };
    }
  }
  return { ok: true };
}
