import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function safeTarget(root, relativePath, allowlist) {
  if (!allowlist.includes(relativePath)) throw new Error("path_not_allowlisted");
  const base = resolve(root);
  const target = resolve(base, relativePath);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("path_escape");
  return target;
}

// 只负责本地已检出的私仓副本；远端提交仍由上层受控完成。
// 写入前校验内容哈希，采用临时文件 + rename，避免半写入。
export async function applyBoundedWrite({
  root,
  relativePath,
  allowlist,
  expectedSha256,
  newContent,
}) {
  const target = safeTarget(root, relativePath, allowlist);
  const stat = await lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe_target_type");
  const oldContent = await readFile(target, "utf8");
  const beforeSha256 = sha256(oldContent);
  if (beforeSha256 !== expectedSha256) throw new Error("baseline_moved");
  await mkdir(dirname(target), { recursive: true });
  const temp = target + ".p5-tmp";
  await writeFile(temp, newContent, { encoding: "utf8", mode: stat.mode });
  await rename(temp, target);
  return {
    target,
    beforeSha256,
    afterSha256: sha256(newContent),
    oldContent,
  };
}

export async function rollbackBoundedWrite({ applied, expectedCurrentSha256 }) {
  const current = await readFile(applied.target, "utf8");
  if (sha256(current) !== expectedCurrentSha256) throw new Error("rollback_target_moved");
  const temp = applied.target + ".p5-rollback-tmp";
  await writeFile(temp, applied.oldContent, "utf8");
  await rename(temp, applied.target);
  return {
    target: applied.target,
    restoredSha256: sha256(applied.oldContent),
    failureEvidencePreserved: true,
  };
}
