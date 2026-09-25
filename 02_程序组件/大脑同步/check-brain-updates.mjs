// 大脑更新检查器：用只读令牌获取私有大脑仓库最新提交，
// 与公开仓库里的信号文件比较，SHA 变化时更新信号文件。
// 公开仓库只保存 SHA/时间/消息摘要，不保存任何大脑正文或凭据。

import fs from "node:fs";
import path from "node:path";

const DEFAULT_BRAIN_REPO = "wujianfa19-hash/yongjiu-danao";
const DEFAULT_SIGNAL_FILE = "sync/brain-check.json";

const token = process.env.BRAIN_READ_TOKEN || "";
const brainRepo = process.env.BRAIN_REPO || DEFAULT_BRAIN_REPO;
const signalFile = process.env.SIGNAL_FILE || DEFAULT_SIGNAL_FILE;
const minIntervalMs = Number(process.env.MIN_INTERVAL_SECONDS || 0) * 1000;

if (!token) {
  console.error("BRAIN_READ_TOKEN is required");
  process.exit(2);
}

function readSignal() {
  try {
    return JSON.parse(fs.readFileSync(signalFile, "utf8"));
  } catch {
    return null;
  }
}

async function fetchLatestCommit() {
  const url = `https://api.github.com/repos/${brainRepo}/commits?per_page=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "github-ai-executor-brain-sync",
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error("GitHub API returned no commits");
  }
  const c = body[0];
  return {
    sha: c.sha,
    date: c.commit?.committer?.date || c.commit?.author?.date || "",
    message: (c.commit?.message || "").split("\n")[0].slice(0, 120),
  };
}

async function main() {
  const latest = await fetchLatestCommit();
  const prev = readSignal();

  if (prev && prev.latestSha === latest.sha) {
    console.log(`NO_CHANGE latestSha=${latest.sha}`);
    return;
  }

  const now = new Date().toISOString();
  if (prev && minIntervalMs > 0) {
    const lastChecked = Date.parse(prev.checkedAtUtc || "");
    if (Number.isFinite(lastChecked) && now !== "" && Date.now() - lastChecked < minIntervalMs) {
      console.log(`SKIP_COOLDOWN latestSha=${latest.sha}`);
      return;
    }
  }

  const signal = {
    brainRepo,
    latestSha: latest.sha,
    latestCommitDate: latest.date,
    messageSummary: latest.message,
    checkedAtUtc: now,
  };

  fs.mkdirSync(path.dirname(signalFile), { recursive: true });
  fs.writeFileSync(signalFile, JSON.stringify(signal, null, 2) + "\n", "utf8");
  console.log(`CHANGED latestSha=${latest.sha}`);
}

main().catch((err) => {
  console.error(`CHECK_FAILED: ${err.message}`);
  process.exit(1);
});
