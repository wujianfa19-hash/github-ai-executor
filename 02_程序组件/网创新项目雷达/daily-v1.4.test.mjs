import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyReport, cnValue, projectMarkdown, recommendationText, selectFinalRecords } from "./daily-v1.4.mjs";

const config = {
  scan: { min_daily_recommendations: 1, max_final_recommendations: 5 },
  thresholds: { min_opportunity_score_final: 65, min_action_index_final: 60 }
};

function record(overrides = {}) {
  return {
    projectId: overrides.projectId || "p1",
    name: overrides.name || "测试项目",
    opportunityScore: overrides.opportunityScore ?? 50,
    actionIndex: overrides.actionIndex ?? 45,
    evidenceScore: overrides.evidenceScore ?? 40,
    lifecycle: overrides.lifecycle || "S1",
    belowThresholdFallback: false,
    selectionNote: "",
    facts: {
      mainland_registration: "supported",
      kyc_status: "unknown",
      payout_methods: ["PayPal"],
      mainland_payout: "unknown",
      settlement_details: "最低提现20美元",
      recent_payout_cases: [],
      risks: ["中国大陆实名认证规则仍需确认"],
      ...overrides.facts
    },
    analysis: {
      summary: "这是一个测试项目。",
      why_now: "近期刚出现公开信号。",
      monetization_paths: ["向客户提供服务并收费"],
      first_money_loop: "找到客户→提供服务→客户付款→提现",
      seven_day_test: ["确认规则", "联系3个潜在客户", "交付最小服务", "验证收款"],
      today_action: "先确认官方注册和提现规则。",
      source_urls: ["https://example.com/rules"],
      ...overrides.analysis
    },
    url: "https://example.com/project",
    homepage: "https://example.com",
    discussionUrl: "",
    evidenceSources: [{ kind: "official", url: "https://example.com/rules", official: true }],
    evidenceErrors: [],
    ...overrides
  };
}

test("没有项目过正式门槛时，仍至少展示一条并明确备注", () => {
  const result = selectFinalRecords([
    record({ projectId: "a", actionIndex: 48, evidenceScore: 50 }),
    record({ projectId: "b", actionIndex: 40, evidenceScore: 80 })
  ], config);
  assert.equal(result.length, 1);
  assert.equal(result[0].belowThresholdFallback, true);
  assert.match(result[0].selectionNote, /未达到正式推荐门槛/);
});

test("达到正式门槛的项目不标记为最低展示候选", () => {
  const result = selectFinalRecords([
    record({ projectId: "a", opportunityScore: 80, actionIndex: 75, evidenceScore: 70 })
  ], config);
  assert.equal(result.length, 1);
  assert.equal(result[0].belowThresholdFallback, false);
});

test("面向用户的状态词转换成中文", () => {
  assert.equal(cnValue("unknown"), "未确认");
  assert.equal(cnValue("confirmed"), "已确认");
  assert.equal(cnValue("unsupported"), "不支持");
  assert.equal(cnValue("conditional"), "有条件支持");
});

test("推荐级别只保留观察、可小试、值得行动", () => {
  assert.equal(recommendationText(record({ belowThresholdFallback: true, actionIndex: 80, evidenceScore: 80 })), "观察");
  assert.equal(recommendationText(record({ actionIndex: 65, evidenceScore: 60 })), "可小试");
  assert.equal(recommendationText(record({ actionIndex: 80, evidenceScore: 75 })), "值得行动");
});

test("项目输出合并为六个核心模块并剔除重复字段", () => {
  const text = projectMarkdown(record({ opportunityScore: 80, actionIndex: 72, evidenceScore: 68 }), 1);
  for (const heading of ["【结论】", "【项目与机会】", "【怎么赚钱】", "【大陆用户能不能做】", "【风险与未确认】", "【行动方案】", "【证据】"]) {
    assert.match(text, new RegExp(heading.replace(/[【】]/g, "\\$&")));
  }
  for (const removed of ["机会评分：", "大陆手机号", "长期投入价值", "总体置信度", "变现类型", "税务或公司主体要求", "真实到账置信度"]) {
    assert.doesNotMatch(text, new RegExp(removed));
  }
});

test("日报底部只保留压缩后的扫描链路", () => {
  const text = buildDailyReport([record()], { raw: 90, deduped: 82, quick: 24, deep: 8 }, []);
  assert.match(text, /今日扫描：.*90 条.*24 条候选.*8 条深度核验.*展示 1 条/);
  assert.doesNotMatch(text, /去重后：/);
  assert.doesNotMatch(text, /语言说明/);
});
