/**
 * Fact schema v2 的結構化欄位：`callee` 與 `container`。
 *
 * Adapter 以語言中立的形狀描述呼叫與位置，interpreter 與專案規則只比對這些欄位，
 * 不解析各語言的語法字串。`text` 只供顯示。
 *
 * callee：`{ text, name, receiver, kind, optional }`
 * - `name`：method / function 名稱。
 * - `receiver`：去掉語言符號的 receiver 路徑（`$this->adminDB` → `['this', 'adminDB']`、
 *   `\Illuminate\Support\Facades\Gate` → `['Illuminate', 'Support', 'Facades', 'Gate']`）；
 *   無法化成路徑時（呼叫鏈、運算式）為 null。function 的 receiver 是 namespace 路徑。
 * - `kind`：`method` | `static` | `function` | `constructor`。
 * - `optional`：PHP `?->` / TS `?.`。
 *
 * container：`{ type, keys, text, name?, callee?, argument?, outer? }`
 * - `type`：`argument` | `property` | `const` | `assign` | `return` | `if` | `while` | `for` |
 *   `ternary` | `match` | `match-arm` | `param` | `closure-use` | `global` | `static` | `file`。
 * - `keys`：巢狀陣列 / 物件的字串 key 路徑。
 * - `name`：`property` / `const` / `assign` 的名稱（不含 `$`）。
 * - `callee` / `argument`：`argument` 的所屬呼叫（可能為 null）與位置（數字）或具名參數名稱（字串）。
 * - `outer`：所屬呼叫本身位於另一個呼叫的參數中時，外層參數的 container（`charge(fee(x))` 中 `fee#0` 的 outer 是 `charge#0`）。
 */

export const CALLEE_KINDS = Object.freeze(['method', 'static', 'function', 'constructor']);

/**
 * 回傳形狀合法的 callee，否則 null。
 *
 * @param {unknown} value - fact properties 中的 callee。
 * @returns {{text: string, name: string, receiver: string[]|null, kind: string, optional: boolean}|null} callee。
 */
export function structuredCallee(value) {
  if (
    !value
    || typeof value !== 'object'
    || typeof value.text !== 'string'
    || typeof value.name !== 'string'
    || value.name === ''
    || !CALLEE_KINDS.includes(value.kind)
    || typeof value.optional !== 'boolean'
    || !(value.receiver === null || (Array.isArray(value.receiver) && value.receiver.every((part) => typeof part === 'string')))
  ) {
    return null;
  }
  return value;
}

/**
 * 回傳形狀合法的 container，否則 null。
 *
 * @param {unknown} value - fact properties 中的 container。
 * @returns {object|null} container。
 */
export function structuredContainer(value) {
  if (
    !value
    || typeof value !== 'object'
    || typeof value.type !== 'string'
    || typeof value.text !== 'string'
    || !Array.isArray(value.keys)
    || !value.keys.every((key) => typeof key === 'string')
  ) {
    return null;
  }
  return value;
}

/**
 * receiver 最後一段（`['this', 'adminDB']` → `adminDB`）；沒有 receiver 時為空字串。
 *
 * @param {object|null} callee - structured callee。
 * @returns {string} 最後一段。
 */
export function receiverLast(callee) {
  return callee?.receiver?.at(-1) ?? '';
}

/**
 * receiver 路徑是否等於其中一個候選（以 `\` 連接比較，例如 `Illuminate\Support\Facades\Gate`）。
 *
 * @param {object|null} callee - structured callee。
 * @param {Iterable<string>} candidates - 候選路徑。
 * @returns {boolean} 是否相符。
 */
export function receiverIs(callee, candidates) {
  if (!Array.isArray(callee?.receiver)) return false;
  const joined = callee.receiver.join('\\');
  return [...candidates].includes(joined);
}

/**
 * fact 的 callee 或 container 的顯示文字。
 *
 * @param {unknown} value - structured callee / container，或舊格式字串。
 * @returns {string} 顯示文字。
 */
export function displayText(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.text === 'string') return value.text;
  return value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
}

/**
 * 參數位置的顯示文字：位置參數為 `#0`，具名參數為名稱。
 *
 * @param {unknown} argument - fact properties.argument。
 * @returns {string} 顯示文字。
 */
export function displayArgument(argument) {
  return typeof argument === 'number' ? `#${argument}` : String(argument ?? '');
}
