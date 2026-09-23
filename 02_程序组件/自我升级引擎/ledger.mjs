// ① 自动收集。只接受有来源的结构化事件；正文不可执行。
// 连续两次采集同一 dedupeKey 不重复写入；失败不覆盖已确认记录。
import { assertEventShape } from "./signals.mjs";

export function emptyLedger() {
  return { events: [], rejected: [] };
}

function clone(ledger) {
  return {
    events: ledger.events.map((event) => ({ ...event })),
    rejected: ledger.rejected.map((item) => ({ ...item })),
  };
}

// event 必填：source, occurredAt, project, signal, outcome, dedupeKey
// 选填：evidence, rootCauseVerified, scope, status
// 缺 evidence 时 status 强制为 pending_verification，不得标成已核实。
export function ingest(ledger, event) {
  const next = clone(ledger || emptyLedger());
  const shape = assertEventShape(event || {});
  if (!shape.ok) {
    next.rejected.push({ dedupeKey: event?.dedupeKey || null, reason: shape.reason });
    return { ledger: next, accepted: false, reason: shape.reason };
  }
  if (next.events.some((item) => item.dedupeKey === event.dedupeKey)) {
    return { ledger: next, accepted: false, reason: "duplicate", duplicate: true };
  }
  const hasEvidence = Boolean(event.evidence && String(event.evidence).trim());
  const stored = {
    source: String(event.source),
    occurredAt: new Date(event.occurredAt).toISOString(),
    project: String(event.project),
    signal: event.signal,
    outcome: String(event.outcome),
    evidence: hasEvidence ? String(event.evidence) : null,
    rootCauseVerified: hasEvidence ? Boolean(event.rootCauseVerified) : false,
    scope: event.scope ? String(event.scope) : "unspecified",
    status: hasEvidence ? (event.status || "recorded") : "pending_verification",
    dedupeKey: String(event.dedupeKey),
    // 事件正文永不进入可执行通道。
    executable: false,
  };
  next.events.push(stored);
  return { ledger: next, accepted: true, event: stored };
}

export function ingestBatch(ledger, events) {
  let current = ledger || emptyLedger();
  const results = [];
  for (const event of events || []) {
    const result = ingest(current, event);
    current = result.ledger;
    results.push({ dedupeKey: event?.dedupeKey || null, accepted: result.accepted, reason: result.reason || null });
  }
  return { ledger: current, results };
}
