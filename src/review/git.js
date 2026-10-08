import { execFile } from 'node:child_process';

const MAX_BLOB_BYTES = 256 * 1024 * 1024;

/**
 * 執行 git 並回傳 stdout（Buffer）；失敗時帶出 stderr。
 *
 * @param {string} repo - repository 路徑。
 * @param {string[]} args - git 參數。
 * @returns {Promise<Buffer>} stdout。
 */
function git(repo, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { encoding: 'buffer', maxBuffer: MAX_BLOB_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`GIT_FAILED:git ${args[0]}: ${String(stderr).trim() || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 解析 ref 為完整 commit SHA。
 *
 * @param {string} repo - repository 路徑。
 * @param {string} ref - branch、tag 或 commit。
 * @returns {Promise<string>} 40 字元 commit SHA。
 */
export async function resolveCommit(repo, ref) {
  if (typeof ref !== 'string' || ref.trim() === '' || ref.startsWith('-')) {
    throw new Error(`GIT_REF_INVALID:${ref}`);
  }
  return (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString('utf8').trim();
}

/**
 * 兩個 commit 的 merge base（`git merge-base`）。沒有共同祖先時丟出 GIT_NO_MERGE_BASE。
 *
 * @param {string} repo - repository 路徑。
 * @param {string} baseSha - base commit。
 * @param {string} headSha - head commit。
 * @returns {Promise<string>} merge base 的 commit SHA。
 */
export async function mergeBase(repo, baseSha, headSha) {
  let output;
  try {
    output = await git(repo, ['merge-base', baseSha, headSha]);
  } catch {
    throw new Error(`GIT_NO_MERGE_BASE:${baseSha}..${headSha}`);
  }
  return output.toString('utf8').trim();
}

/**
 * repository 根目錄（worktree 頂層）的絕對路徑。
 *
 * @param {string} repo - repository 路徑。
 * @returns {Promise<string>} 根目錄的絕對路徑。
 */
export async function repositoryRoot(repo) {
  return (await git(repo, ['rev-parse', '--show-toplevel'])).toString('utf8').trim();
}

/**
 * 解析 `git diff --raw -z --no-abbrev` 的輸出。
 *
 * 每筆格式為 `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0`，
 * rename / copy 另有第二個路徑：`<status>` 為 `R087` 之類，後接 `<old path>\0<new path>\0`。
 *
 * @param {Buffer|string} output - git 輸出。
 * @returns {object[]} diff entries。
 */
export function parseRawDiff(output) {
  const fields = output.toString('utf8').split('\0');
  const entries = [];
  let index = 0;

  while (index < fields.length) {
    const header = fields[index];
    if (header === '') {
      index += 1;
      continue;
    }
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header);
    if (!match) throw new Error(`GIT_DIFF_UNPARSABLE:${header}`);

    const [, oldMode, newMode, oldSha, newSha, status, score] = match;
    const twoPaths = status === 'R' || status === 'C';
    const oldPath = fields[index + 1];
    const newPath = twoPaths ? fields[index + 2] : oldPath;
    // 路徑不會是空字串；缺少路徑代表輸出被截斷或格式不符。
    if (!oldPath || !newPath) throw new Error(`GIT_DIFF_UNPARSABLE:${header}`);

    entries.push({
      status,
      similarity: score === '' ? null : Number(score),
      oldMode,
      newMode,
      oldSha,
      newSha,
      oldPath: status === 'A' ? null : oldPath,
      newPath: status === 'D' ? null : newPath,
    });
    index += twoPaths ? 3 : 2;
  }

  return entries;
}

/**
 * 列出兩個 commit 之間的檔案變更（含 rename 偵測）。
 *
 * @param {string} repo - repository 路徑。
 * @param {string} baseSha - base commit。
 * @param {string} headSha - head commit。
 * @returns {Promise<object[]>} diff entries。
 */
export async function diffEntries(repo, baseSha, headSha) {
  return parseRawDiff(await git(repo, [
    'diff', '--raw', '-z', '--no-abbrev', '-M', '--no-ext-diff', baseSha, headSha,
  ]));
}

/**
 * 解析 `git diff -U0` 的 hunk header（`@@ -a,b +c,d @@`）。
 *
 * @param {Buffer|string} output - git diff 輸出。
 * @returns {Array<{baseStart: number, baseCount: number, headStart: number, headCount: number}>} hunks。
 */
export function parseHunks(output) {
  const hunks = [];
  for (const line of output.toString('utf8').split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      hunks.push({
        baseStart: Number(match[1]),
        baseCount: match[2] === undefined ? 1 : Number(match[2]),
        headStart: Number(match[3]),
        headCount: match[4] === undefined ? 1 : Number(match[4]),
      });
    }
  }

  return hunks;
}

/**
 * 單一檔案（含 rename）在兩個 commit 之間的變更 hunk。
 *
 * @param {string} repo - repository 路徑。
 * @param {string} baseSha - base commit。
 * @param {string} headSha - head commit。
 * @param {string[]} paths - 檔案路徑（rename 時為舊路徑與新路徑）。
 * @returns {Promise<object[]>} hunks。
 */
export async function diffHunks(repo, baseSha, headSha, paths) {
  return parseHunks(await git(repo, [
    'diff', '-U0', '--no-color', '--no-ext-diff', '-M', baseSha, headSha, '--', ...paths,
  ]));
}

/**
 * 讀取 blob 內容。
 *
 * @param {string} repo - repository 路徑。
 * @param {string} sha - blob SHA。
 * @returns {Promise<Buffer>} blob bytes。
 */
export async function readBlob(repo, sha) {
  return git(repo, ['cat-file', 'blob', sha]);
}
