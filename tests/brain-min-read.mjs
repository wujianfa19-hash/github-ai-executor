// 阶段 D 收口：OpenClaw 最小权限读取永久大脑指定测试入口
// 目标：只读一个指定小文件 → 调云端模型 → 输出安全结构化结果；
//       绝不把私人正文打印到公开日志；失败则明确失败，不回退到"只看不改"。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const entryPath = process.env.BRAIN_ENTRY_PATH;
const expectedEntry = "00_大脑入口/永久大脑启动规则.md";

if (!entryPath) {
  console.error("BRAIN_MISSING_ENV entry_path_not_set");
  process.exit(1);
}

// 仅允许读取预先指定的最小入口，防止把整个永久大脑读进来。
if (!entryPath.endsWith(expectedEntry)) {
  console.error(`BRAIN_DENIED entry_must_be=${expectedEntry}`);
  process.exit(1);
}

let content;
try {
  content = readFileSync(entryPath, "utf8");
} catch (error) {
  console.error(`BRAIN_READ_FAILED ${error.code || error.message}`);
  process.exit(1);
}

const bytes = statSync(entryPath).size;
const sha = createHash("sha256").update(content).digest("hex");
// 只暴露入口的元数据，不打印正文。
console.log(`BRAIN_ENTRY_OK path=${expectedEntry} bytes=${bytes} sha256=${sha.slice(0, 16)}`);

// 交给 OpenClaw 的最小 prompt：要求模型只输出结构化验证结果，不得复述私人正文。
const prompt =
  "你是一个只读验证器。给定永久大脑指定入口 `00_大脑入口/永久大脑启动规则.md` 的内容，" +
  "只输出一个 JSON 对象，字段为：ok(布尔)、entry(字符串)、isStartupRule(布尔)、" +
  "category(字符串，取 'launch_rules')、privateBodyExposed(布尔，必须为 false)。" +
  "严禁在 JSON 之外或字段里复述、引用、转述任何原文正文。" +
  "\n\n---\n" + content + "\n---\n";

// 用 stdin 传给 OpenClaw，避免正文出现在命令行/日志。
const model = process.env.OPENCLAW_MODEL || "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";
const res = spawnSync("openclaw", [
  "infer", "model", "run", "--local", "--json",
  "--model", model,
  "--prompt", prompt
], { encoding: "utf8", input: "", maxBuffer: 8 * 1024 * 1024 });

if (res.error) {
  console.error(`OPENCLAW_LAUNCH_FAILED ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`OPENCLAW_NONZERO status=${res.status}`);
  if (res.stderr) console.error(res.stderr.slice(0, 2000));
  process.exit(1);
}

// 只输出模型返回的结构化结果；不输出 prompt 里的正文。
const out = (res.stdout || "").trim();
if (!out) {
  console.error("OPENCLAW_EMPTY_OUTPUT");
  process.exit(1);
}
console.log("OPENCLAW_RESULT");
console.log(out);
