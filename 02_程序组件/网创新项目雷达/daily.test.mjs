import test from "node:test";
import assert from "node:assert/strict";
import {
  actionIndex,
  dedupeCandidates,
  detectChanges,
  evidenceScore,
  hardLimitRecommendation,
  projectId,
  quickScore
} from "./src/core.mjs";
import { buildRecord, fallbackAnalysis } from "./daily.mjs";

test("dedupe merges same GitHub repository", () => {
  const rows = dedupeCandidates([
    { source: "github", githubFullName: "Acme/Test", name: "Acme/Test", url: "https://github.com/Acme/Test", stars: 10 },
    { source: "hacker_news", githubFullName: "Acme/Test", title: "Show HN Acme", url: "https://github.com/Acme/Test", comments: 8 }
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stars, 10);
  assert.equal(rows[0].comments, 8);
  assert.deepEqual(rows[0].sourceSignals.sort(), ["github", "hacker_news"]);
});

test("project id is stable for github", () => {
  assert.equal(projectId({ githubFullName: "Owner/Repo" }), "github:owner/repo");
});

test("evidence score only rewards verified facts", () => {
  assert.equal(evidenceScore({ launch_status: "confirmed", mainland_registration: "unknown", kyc_status: "unknown", payout_status: "unknown", first_money_loop_status: "unconfirmed", recent_payout_cases: [], risk_evidence_status: "unknown" }), 15);
  assert.equal(evidenceScore({ launch_status: "confirmed", mainland_registration: "supported", kyc_status: "not_required", payout_status: "confirmed", first_money_loop_status: "confirmed", recent_payout_cases: [{ url: "x" }], risk_evidence_status: "confirmed" }), 100);
});

test("action index dynamically normalizes when personal profile is absent", () => {
  const value = actionIndex({ opportunityScore: 80, mainlandScore: 80, payoutScore: 80, urgencyScore: 80, longTermScore: 80 });
  assert.equal(value, 80);
});

test("unknown mainland facts cap recommendation", () => {
  const result = hardLimitRecommendation({ facts: { mainland_registration: "supported", kyc_status: "unknown", mainland_payout: "unknown" }, evidence: 60, action: 92 });
  assert.equal(result.maxStars, 3);
  assert.equal(result.actionIndex, 74);
});

test("changes are detected only after a previous state exists", () => {
  assert.deepEqual(detectChanges(null, {}), []);
  const changes = detectChanges({ actionIndex: 60, facts: { kyc_status: "unknown", recent_payout_cases: [] } }, { actionIndex: 75, facts: { kyc_status: "supported", recent_payout_cases: [{ url: "x" }] } });
  assert.ok(changes.some((x) => x.includes("KYC")));
  assert.ok(changes.some((x) => x.includes("到账案例")));
  assert.ok(changes.some((x) => x.includes("行动指数")));
});

test("fallback analysis is conservative", () => {
  const c = { source: "github", sourceSignals: ["github"], name: "x", title: "x", description: "new creator marketplace", url: "https://example.com", publishedAt: new Date().toISOString() };
  c.projectId = projectId(c);
  const analysis = fallbackAnalysis(c);
  assert.equal(analysis.facts.mainland_registration, "unknown");
  assert.equal(analysis.facts.payout_status, "unknown");
  assert.ok(quickScore(c) > 0);
});

test("record with unknown payout cannot become strong recommendation", () => {
  const c = { source: "github", sourceSignals: ["github"], name: "x", title: "x", description: "new creator marketplace", url: "https://example.com", publishedAt: new Date().toISOString(), projectId: "web:example.com:" };
  const r = buildRecord(c, fallbackAnalysis(c), { sources: [], errors: [] });
  assert.ok(r.actionIndex <= 74);
  assert.match(r.recommendationStars, /^★{1,3}☆/);
});
