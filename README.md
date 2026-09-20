# GitHub AI Executor｜公开云端执行器

> 本仓库只负责**执行自动化任务**，不含任何私人数据、密钥或永久大脑正文。
> 公开仓库 = 程序；私人仓库 = 数据。

## 职责边界

- ✅ 公开执行器保存：`.github/workflows/`、`02_程序组件/` 下的运行脚本、`tests/`、公共配置。
- ❌ 公开执行器不保存：永久大脑私人正文、私人历史报告、私人状态（`data/` `reports/`）、邮箱授权、大模型密钥、私人仓库访问令牌。

## 数据目录如何解耦

所有任务脚本支持环境变量覆盖数据目录，不再强制把数据写在脚本目录里：

| 环境变量 | 作用 |
|---|---|
| `DATA_DIR` / `STATE_DIR` | 覆盖私人状态目录（默认脚本目录下 `data/`） |
| `REPORT_DIR` | 覆盖报告输出目录（默认脚本目录下 `reports/`） |
| `REPORT_OUTPUT_DIR` / `REPORT_HISTORY_PATH` | 日报历史与报告目录 |

未设置时回落到脚本相对目录，保证本地可用；设置了则完全脱离仓库，写向私人数据位置。

## 已迁移任务

> 公开仓库程序骨架与代码拆分已完成；云端执行能力正在逐任务真实验证中。

| 工作流 | 状态 |
|---|---|
| `api-provider-smoke-test.yml` | 已推送并真实运行（单元测试通过；模型路由验证待配置模型 Secrets） |
| `free-ai-resource-radar.yml` | 脚本/依赖已就位，待迁移 |
| `github-ai-daily.yml` | 脚本/依赖已就位，待迁移 |
| `net-venture-radar.yml` | 脚本/依赖已就位，待迁移 |

### 第一次真实运行记录

- 工作流远端提交：`a0c5bf3`
- 运行号：`35524148675`（手动触发）
- 单元测试全部通过（radar / GitHub AI Daily / npm test）
- 模型路由验证失败根因：`AI_ROUTER free_only=true configured=0` → 公开仓库未配置任何模型 Secrets
- 日志安全检查：无任何私有凭据 / 邮箱 / 私人正文泄漏
| `github-ai-daily.yml` | 脚本/依赖已就位，待迁移 |
| `net-venture-radar.yml` | 脚本/依赖已就位，待迁移 |

## 安全规范

- 所有密钥经 GitHub Actions **Secrets** 注入，绝不写入代码或日志。
- 运行日志只记录：任务名、阶段、返回码、错误类型、必要的匿名统计。
- 外部 PR 无法触发带私人凭据的高权限任务。