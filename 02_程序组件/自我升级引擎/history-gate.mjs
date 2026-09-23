// 历史/影子观察门禁。只统计真实、有证据、已完成的事件日期。
// 同一天无论多少次运行只算一个观察日，避免靠重复触发凑样本。

export function assessObservation(events, options = {}) {
  const minDistinctDates = options.minDistinctDates ?? 5;
  const accepted = (events || []).filter((event) => {
    if (!event?.evidence || !event?.occurredAt) return false;
    if (event.status === "pending_verification") return false;
    return !Number.isNaN(Date.parse(event.occurredAt));
  });
  const dates = [...new Set(accepted.map((event) => new Date(event.occurredAt).toISOString().slice(0, 10)))].sort();
  return {
    passed: dates.length >= minDistinctDates,
    distinctDates: dates,
    observedDays: dates.length,
    requiredDays: minDistinctDates,
    acceptedEvents: accepted.length,
    reason: dates.length >= minDistinctDates ? null : "insufficient_distinct_dates",
  };
}
