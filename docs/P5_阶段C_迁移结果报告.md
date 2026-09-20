# P5 阶段 C｜4 个自动任务迁移结果报告

> 创建：2026-09-21
> 公开执行仓库：`wujianfa19-hash/github-ai-executor`
> 现状态：阶段 C 进行中——4 个任务已全部迁移，1 个真实验收通过、3 个 dry_run 通过；真实运行待用户配置 Gmail + 私人仓库写回凭据。

## 总览

| 任务 | 迁移状态 | 新公开工作流路径 | 最后测试时间 | 最后运行编号 | 发邮件 | 写回私人仓库 | 权限模型 | 正式 schedule | 旧私人工作流 |
|---|---|---|---|---|---|---|---|---|---|
| api-provider-smoke-test | ✅ 已迁移真实验收通过 | `.github/workflows/api-provider-smoke-test.yml` | 2026-09-21 | `35535728116` | 否 | 否 | 无写回（纯测试） | 不开 | 保留（本身无 schedule） |
| github-ai-daily | 🟡 已迁移 dry_run 通过 | `.github/workflows/github-ai-daily.yml` | 2026-09-21 | `35536398184` | dry_run 不要 | 待真实确认 | 需受限写回 | 不开 | 保留 |
| free-ai-resource-radar | 🟡 已迁移 dry_run 通过 | `.github/workflows/free-ai-resource-radar.yml` | 2026-09-21 | `35536842864` | dry_run 不要 | 待真实确认 | 需受限写回 | 不开 | 保留 |
| net-venture-radar | 🟡 已迁移 dry_run 通过 | `.github/workflows/net-venture-radar.yml` | 2026-09-21 | `35537211768` | dry_run 不要 | 待真实确认 | 需受限写回 | 不开 | 保留 |

## 逐任务真实测试结果

### 1. api-provider-smoke-test（✅ 完全验收）
- 8 个模型 Secrets 已从本机 Sub2API 数据库取 key 配置到公开仓库。
- 路由验证真实成功：`provider=groq status=success`，旧 DeepSeek 接口已被替换（未走 legacy）。
- 容灾验证真实成功：去掉 Groq 后 nvidia 超时 → openrouter 超时 → `sensenova` 成功（`ROUTER_FAILOVER_OK provider=sensenova`）。
- 网创雷达模型路径 `NET_VENTURE_RADAR_ROUTER_OK`、日报模型路径 `GITHUB_AI_DAILY_ROUTER_OK`。
- 全部单元测试真实通过；公开日志泄漏扫描干净（714 行无任何凭据）。
- 无私人数据、无新定时、不依赖私人仓库 Actions 分钟数。

### 2. github-ai-daily（dry_run 通过）
- 程序链路真实可用：报告生成到临时目录 `/tmp/github-ai-daily-dryrun/github-ai-daily-2026-09-21.md`（projects=10）。
- 8 个 provider 全被尝试，全失败后 `DEEPSEEK_FALLBACK` → 模板报告 `REPORT_QUALITY_OK score=100/85`。
- 未发正式邮件、未写正式历史、无 commit/push；日志无泄漏。

### 3. free-ai-resource-radar（dry_run 通过）
- 真实探测 8 个 provider 健康（多个 health=ok），报告 `/tmp/free-ai-resource-radar-dryrun/free-ai-resource-radar-2026-09-21.md`。
- `ok=true, dryRun=true`；未发邮件、未写 state；日志无泄漏。

### 4. net-venture-radar（dry_run 通过）
- 报告 `/tmp/net-venture-radar-dryrun/net-venture-radar-2026-09-21.md`；`ok=true, dryRun=true`。
- 未发邮件、未写 state；日志无泄漏。

## 待用户处理的真实运行阻塞

- **Gmail OAuth 凭据**：`GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `GMAIL_SENDER_EMAIL` / `REPORT_RECIPIENT_EMAIL` —— 外部账号凭据，GitHub 不提供复制真实值。
- **私人仓库受限写回 Token**（`PRIVATE_REPO_TOKEN`）：单仓库最小权限，仅授权 `github-ai-daily-intelligence` contents write。

## 回滚方式
- 4 个工作流默认 `workflow_dispatch` 手动触发，无正式 schedule，无自动改动风险。
- dry_run 模式全部写临时目录，不触及私人 state/reports。
- 出问题时直接从公开仓库删除对应 `.yml` 即可，旧私人工作流原样保留。

## 下一步
- 用户配置 Gmail + 私有写回凭据后：逐个把 3 个任务从 dry_run 切到真实运行验收。
- 真实运行前不开启正式 schedule；切换时先关旧私人定时再开新公开定时，避免双跑。