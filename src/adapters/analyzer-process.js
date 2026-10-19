import { spawn } from 'node:child_process';

/**
 * 以子行程執行 analyzer：stdin 寫入 JSON payload，stdout 解析為 JSON。
 *
 * 錯誤訊息以 `prefix` 開頭：`<prefix>_ABORTED`（deadline / abort）、`<prefix>_EXIT_<code>:<stderr>`、
 * `<prefix>_OUTPUT_INVALID`（stdout 不是 JSON）；找不到執行檔時 reject spawn error。
 *
 * @param {object} options - 執行選項。
 * @param {string} options.command - 執行檔（例如 `php`、`node`）。
 * @param {string[]} options.args - 參數。
 * @param {object} options.payload - stdin payload。
 * @param {AbortSignal|undefined} options.signal - abort signal。
 * @param {string} options.prefix - 錯誤代碼前綴，例如 `PHP_ANALYZER`。
 * @returns {Promise<object>} analyzer JSON result。
 */
export function executeAnalyzer({ command, args, payload, signal, prefix }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    const onAbort = () => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new Error(`${prefix}_ABORTED`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${prefix}_EXIT_${code}:${stderr.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`${prefix}_OUTPUT_INVALID`));
      }
    });

    // analyzer 可能在讀完 stdin 前就結束（例如缺少依賴時直接回報錯誤）。寫入失敗（EPIPE）
    // 不可成為未處理的 error 事件；結果一律由 close 時的 exit code 與 stdout 決定。
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}
