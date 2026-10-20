import { realpathSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * 模組是否為這次執行的入口（例如 `node bin/review.js`）。以 realpath 比較：npm 安裝的 `reviewer` 指令是指向
 * bin 檔的 symlink。被 `bin/reviewer.js` 當成子指令載入時不是入口，不自動執行。
 *
 * @param {string} moduleUrl - 模組的 `import.meta.url`。
 * @param {string[]} [argv=process.argv] - process 的參數。
 * @returns {boolean} 是否為入口。
 */
export function isEntry(moduleUrl, argv = process.argv) {
  if (typeof argv[1] !== 'string' || argv[1] === '') return false;
  try {
    return realpathSync(argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
