import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * 等待 child process 結束；非 0 exit code 時 reject 並帶出 stderr。
 *
 * @param {import('node:child_process').ChildProcess} child - child process。
 * @param {string} name - 錯誤訊息用名稱。
 * @param {{captureStdout?: boolean}} [options={}] - stdout 被 pipe 給其他 process 時不可讀取。
 * @returns {Promise<string>} stdout（未讀取時為空字串）。
 */
function finished(child, name, { captureStdout = true } = {}) {
  let stdout = '';
  let stderr = '';
  if (captureStdout) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
  }
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.on('error', (error) => reject(new Error(`${name}:${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${name} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * 把 reviewer 的某個 git ref 解開成獨立 snapshot，並準備 PHP analyzer 依賴。
 *
 * - 原始碼以 `git archive` 取得，不動到目前的 working tree 與 git 狀態。
 * - snapshot 的 composer.lock 與目前相同時直接複製 vendor/（autoload 路徑皆為相對路徑）；
 *   不同時以 composer install 安裝該版本鎖定的依賴。
 * - 沒有 composer.json 的舊版本（token-based analyzer）不需要依賴。
 *
 * @param {object} options - snapshot 選項。
 * @param {string} options.reviewerRoot - 目前的 reviewer repo 根目錄。
 * @param {string} options.ref - git ref（branch、tag、commit）。
 * @param {string} options.directory - 已存在的空目錄。
 * @returns {Promise<string>} snapshot 的 commit SHA。
 */
export async function prepareBaseline({ reviewerRoot, ref, directory }) {
  const commit = (await finished(
    spawn('git', ['-C', reviewerRoot, 'rev-parse', '--verify', `${ref}^{commit}`], { stdio: ['ignore', 'pipe', 'pipe'] }),
    `git rev-parse ${ref}`,
  )).trim();

  const archive = spawn('git', ['-C', reviewerRoot, 'archive', '--format=tar', commit], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const extract = spawn('tar', ['-x', '-C', directory], { stdio: ['pipe', 'ignore', 'pipe'] });
  // pipeline 會把 tar 提早結束造成的 EPIPE 轉成 rejection，而不是未處理的 error 事件。
  await Promise.all([
    pipeline(archive.stdout, extract.stdin),
    finished(archive, 'git archive', { captureStdout: false }),
    finished(extract, 'tar'),
  ]);

  const analyzerDirectory = join(directory, 'analyzers/php');
  if (!existsSync(join(analyzerDirectory, 'composer.json'))) {
    return commit;
  }

  const currentLock = join(reviewerRoot, 'analyzers/php/composer.lock');
  const snapshotLock = join(analyzerDirectory, 'composer.lock');
  const currentVendor = join(reviewerRoot, 'analyzers/php/vendor');
  const sameLock = existsSync(currentLock)
    && existsSync(snapshotLock)
    && await readFile(currentLock, 'utf8') === await readFile(snapshotLock, 'utf8');

  if (sameLock && existsSync(currentVendor)) {
    await cp(currentVendor, join(analyzerDirectory, 'vendor'), { recursive: true });
  } else {
    await finished(
      spawn('composer', ['install', '--no-dev', '--no-interaction', '--no-progress', `--working-dir=${analyzerDirectory}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
      'composer install',
    );
  }

  return commit;
}
