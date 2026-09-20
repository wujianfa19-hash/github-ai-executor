# OpenClaw 阶段 D 最小验证测试资料

这是公开执行仓库内用于验证 OpenClaw 能否在临时云端环境完成
"读文件 → 调用云端大模型 → 输出结构化结果 → 退出" 的一次性任务的
最小测试资料，不包含任何私人正文。

本文件仅用于验证 OpenClaw 链路可用。请读取本文件，并调用云端模型，
输出一个 JSON，格式：{"openc": true, "ok": true, "message": "OpenClaw cloud min test passed"}。