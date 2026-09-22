// ⑤ 影子运行。候选只在隔离结果里和稳定版比差异，不改正式结果。
// 样本数、安全失败数未达预先写定阈值时保持 observing，一次成功不能升格。

export function shadowRun({ stableOutput, candidateOutput, samples, safetyFailures, minSamples, maxSafetyFailures }) {
  const required = minSamples ?? 5;
  const allowedFailures = maxSafetyFailures ?? 0;
  const divergences = [];
  if (stableOutput !== candidateOutput) {
    divergences.push({ kind: "output_diff", stable: stableOutput, candidate: candidateOutput });
  }
  const enough = (samples ?? 0) >= required && (safetyFailures ?? 0) <= allowedFailures;
  return {
    mode: "shadow",
    appliedToFormal: false,
    samples: samples ?? 0,
    required,
    safetyFailures: safetyFailures ?? 0,
    divergences,
    status: enough ? "threshold_met" : "observing",
    // 即使达阈值，真实用户效果仍待持续观察，不在本环宣布验收完成。
    longRunAccepted: false,
  };
}
