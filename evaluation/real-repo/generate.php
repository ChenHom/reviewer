<?php

declare(strict_types=1);

/*
 * 從真實 PHP repo 產生帶標籤的 mutation corpus（JSONL，每行一筆）。
 *
 * 用法：
 *   php evaluation/real-repo/generate.php --root <repo path> --label <name> [--seed 42] [--rate 0.3]
 *
 * 每筆 mutation 以 byte-range edit 表示（保留原始格式），並帶原始檔案的 sha256，
 * 讓 runner 能偵測 corpus 產生後原始檔案已被修改。
 *
 * label：
 * - unchanged：每個檔案一筆，before 與 after 相同，必須判為 NOT_SELECTED。`parseable` 記錄本 script
 *   能否解析該檔案（空檔或兩種語法都無法解析時為 false），只有 false 時才允許不被 reduce。
 * - safe：AST 不變的格式變更（註解、縮排、換行、trailing comma、引號），或 method 內一致的區域變數改名。
 * - risky：AST 改變的語意變更（含讓 `__LINE__` 值改變的換行），絕不能被判為 NOT_SELECTED。
 *
 * 標籤由本 script 獨立驗證：把 before / after 解析後去除所有 attributes 再 pretty print，
 * safe（改名除外）必須相同，risky 必須不同；不符合的 mutation 直接捨棄。比較前 `__LINE__`
 * 會換成實際行號、`__halt_compiler` 會帶上 `__COMPILER_HALT_OFFSET__`（排版變更會改變它們
 * 的值），`TRUE` / `true` 等常數名稱統一為小寫（大小寫不影響語意）。safe 必須在最新語法與
 * PHP 7 視角（7.4 語法、`#[` 視為註解）下都成立。
 *
 * 每個檔案以 seed 與路徑決定自己的亂數序列：新增或刪除其他檔案不會改變該檔案的 mutation。
 * 這個驗證刻意不使用 analyzer 的 Canonicalizer，避免用受測程式碼替自己的結果背書。
 */

// stdout 只能有 JSONL；任何 PHP warning 都導到 stderr。
ini_set('display_errors', 'stderr');

$autoload = dirname(__DIR__, 2) . '/analyzers/php/vendor/autoload.php';
if (!is_file($autoload)) {
    fwrite(STDERR, "PHP analyzer dependencies are missing; run `npm run analyzer:install` first.\n");
    exit(2);
}
require $autoload;

use PhpParser\Error as PhpParserError;
use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Stmt;
use PhpParser\NodeFinder;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\CloningVisitor;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\PhpVersion;
use PhpParser\PrettyPrinter;

const MAX_FILE_BYTES = 300_000;

const PRESERVED_VARIABLES = [
    'this', 'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION',
    '_REQUEST', '_ENV', 'http_response_header', 'php_errormsg', 'argc', 'argv',
];

const NAME_SENSITIVE_FUNCTIONS = ['compact', 'extract', 'get_defined_vars', 'parse_str', 'mb_parse_str', 'assert'];

const OPERATOR_FLIPS = [
    Expr\BinaryOp\Smaller::class => '<=',
    Expr\BinaryOp\SmallerOrEqual::class => '<',
    Expr\BinaryOp\Greater::class => '>=',
    Expr\BinaryOp\GreaterOrEqual::class => '>',
    Expr\BinaryOp\Plus::class => '-',
    Expr\BinaryOp\Minus::class => '+',
    Expr\BinaryOp\BooleanAnd::class => '||',
    Expr\BinaryOp\BooleanOr::class => '&&',
    Expr\BinaryOp\Equal::class => '!=',
    Expr\BinaryOp\Identical::class => '!==',
    Expr\BinaryOp\NotIdentical::class => '===',
];

$options = getopt('', ['root:', 'label:', 'seed:', 'rate:']);
$root = $options['root'] ?? null;
$label = $options['label'] ?? null;
if (!is_string($root) || !is_dir($root) || !is_string($label) || !preg_match('/^[A-Za-z0-9._-]+$/', $label)) {
    fwrite(STDERR, "usage: php generate.php --root <repo path> --label <name> [--seed 42] [--rate 0.3]\n");
    exit(2);
}
$seed = (int) ($options['seed'] ?? 42);
$rate = (float) ($options['rate'] ?? 0.3);
if ($rate < 0 || $rate > 1) {
    fwrite(STDERR, "--rate must be between 0 and 1\n");
    exit(2);
}

/**
 * 列出 repo 內的 PHP 檔案。
 *
 * - git work tree 內：`git ls-files`（只列 index 中的檔案）；失敗時直接結束（exit 2）。
 * - 不是 git repo：遞迴掃描，略過 `.git`、`vendor`、`node_modules`。
 * - git 本身出錯（例如 dubious ownership）時不改用目錄掃描，避免掃到不該掃的檔案。
 *
 * @return list<string> repo 相對路徑（排序、去重）
 */
function listPhpFiles(string $root): array
{
    exec('LC_ALL=C git -C ' . escapeshellarg($root) . ' rev-parse --show-toplevel 2>&1', $output, $status);
    $message = implode("\n", $output);
    if ($status === 0) {
        exec('git -C ' . escapeshellarg($root) . " ls-files -z -- '*.php'", $lines, $listStatus);
        if ($listStatus !== 0) {
            fwrite(STDERR, "git ls-files failed in {$root}\n");
            exit(2);
        }
        $files = array_filter(explode("\0", implode("\n", $lines)), static fn (string $file) => $file !== '');
    } elseif (str_contains($message, 'not a git repository') || ($status === 127 && !hasGitDirectory($root))) {
        $files = [];
        $iterator = new RecursiveIteratorIterator(new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
            static fn (SplFileInfo $file): bool => !in_array($file->getFilename(), ['.git', 'vendor', 'node_modules'], true),
        ));
        foreach ($iterator as $file) {
            if ($file->isFile() && str_ends_with($file->getFilename(), '.php')) {
                $files[] = substr($file->getPathname(), strlen(rtrim($root, '/')) + 1);
            }
        }
    } else {
        fwrite(STDERR, "git failed in {$root}: {$message}\n");
        exit(2);
    }

    // 未解決的 merge conflict 會讓同一路徑出現多次。
    $files = array_values(array_unique($files));
    sort($files, SORT_STRING);

    return $files;
}

/**
 * root 或其上層是否有 `.git`（目錄或 worktree 的 `.git` 檔案）。
 */
function hasGitDirectory(string $root): bool
{
    for ($directory = realpath($root); is_string($directory); $directory = dirname($directory)) {
        if (file_exists($directory . '/.git')) {
            return true;
        }
        if (dirname($directory) === $directory) {
            return false;
        }
    }

    return false;
}

/**
 * PHP 7 對 `#[` 的解讀：`#` 開始單行註解，直到換行或 close tag（與 analyzer 相同）。
 */
function php7View(string $source): string
{
    foreach (PhpToken::tokenize($source) as $token) {
        if ($token->id !== T_ATTRIBUTE) {
            continue;
        }
        $end = strlen($source);
        foreach (["\n", "\r", '?' . '>'] as $terminator) {
            $position = strpos($source, $terminator, $token->pos);
            if ($position !== false && $position < $end) {
                $end = $position;
            }
        }
        $source = substr_replace($source, str_repeat(' ', $end - $token->pos), $token->pos, $end - $token->pos);
    }

    return $source;
}

/**
 * 以最新 PHP 語法與 PHP 7 視角（7.4 語法 + `#[` 為註解）各解析一次。
 *
 * @return array{newest: list<Stmt>|null, php74: list<Stmt>|null}
 */
function parseBothGrammars(string $source): array
{
    $factory = new ParserFactory();
    $parsed = [];
    foreach (['newest', 'php74'] as $grammar) {
        $parser = $grammar === 'newest'
            ? $factory->createForNewestSupportedVersion()
            : $factory->createForVersion(PhpVersion::fromString('7.4'));
        try {
            $parsed[$grammar] = $parser->parse($grammar === 'newest' ? $source : php7View($source)) ?? [];
        } catch (PhpParserError) {
            $parsed[$grammar] = null;
        }
    }

    return $parsed;
}

/**
 * 兩種語法下的 canonical print（無法解析或無法 print 時為 null）。
 *
 * @return array{newest: string|null, php74: string|null}
 */
function grammarPrints(string $source): array
{
    $prints = [];
    foreach (parseBothGrammars($source) as $grammar => $statements) {
        try {
            $prints[$grammar] = $statements === null ? null : canonicalPrint($statements, $source);
        } catch (Throwable) {
            $prints[$grammar] = null;
        }
    }

    return $prints;
}

/**
 * 去除所有 attributes（位置、註解、引號種類、array 語法…）後 pretty print，作為 AST 等價的獨立判斷。
 *
 * @param list<Stmt> $statements
 * @param string $source 該 AST 的原始碼（計算 __COMPILER_HALT_OFFSET__）
 */
function canonicalPrint(array $statements, string $source): string
{
    $stripAttributes = new class (strlen($source)) extends NodeVisitorAbstract {
        public function __construct(private readonly int $sourceLength)
        {
        }

        public function enterNode(Node $node): ?Node
        {
            // 值取決於位置的節點：保留其實際值，讓排版變更造成的差異可被看見。
            if ($node instanceof Node\Scalar\MagicConst\Line) {
                return new Node\Scalar\Int_($node->getStartLine());
            }
            if ($node instanceof Stmt\HaltCompiler) {
                // __COMPILER_HALT_OFFSET__：終止符之後的 byte 位置。
                return new Stmt\HaltCompiler(($this->sourceLength - strlen($node->remaining)) . ':' . $node->remaining);
            }
            if (
                $node instanceof Expr\ConstFetch
                && in_array(strtolower($node->name->toString()), ['true', 'false', 'null'], true)
            ) {
                return new Expr\ConstFetch(new Node\Name(strtolower($node->name->toString())));
            }
            $node->setAttributes([]);
            return null;
        }
    };
    $copy = (new NodeTraverser(new CloningVisitor(), $stripAttributes))->traverse($statements);

    return (new PrettyPrinter\Standard())->prettyPrintFile($copy);
}

/**
 * @param array<mixed> $items
 */
function pick(array $items): mixed
{
    $items = array_values($items);

    return $items === [] ? null : $items[mt_rand(0, count($items) - 1)];
}

/**
 * @return array{0: int, 1: int} [start, end) byte range
 */
function span(Node $node): array
{
    return [$node->getStartFilePos(), $node->getEndFilePos() + 1];
}

function lineStart(string $source, int $offset): int
{
    $position = strrpos(substr($source, 0, $offset), "\n");

    return $position === false ? 0 : $position + 1;
}

/**
 * @param list<array{0: int, 1: int, 2: string}> $edits
 */
function applyEdits(string $source, array $edits): string
{
    usort($edits, static fn (array $left, array $right): int => $right[0] <=> $left[0]);
    foreach ($edits as [$start, $end, $replacement]) {
        $source = substr_replace($source, $replacement, $start, $end - $start);
    }

    return $source;
}

function isGuard(Stmt\If_ $if): bool
{
    if ($if->elseifs !== [] || $if->else !== null || count($if->stmts) !== 1) {
        return false;
    }
    $only = $if->stmts[0];

    return $only instanceof Stmt\Return_
        || ($only instanceof Stmt\Expression && ($only->expr instanceof Expr\Throw_ || $only->expr instanceof Expr\Exit_));
}

/**
 * 檔案內指向 name-sensitive 函式的名稱（含 `use function compact as x` 的別名與 group use）。
 *
 * @param list<Stmt> $ast
 * @return array<string, string> 小寫名稱 → 原始函式名稱
 */
function sensitiveFunctionNames(array $ast): array
{
    $names = array_combine(NAME_SENSITIVE_FUNCTIONS, NAME_SENSITIVE_FUNCTIONS);
    foreach ((new NodeFinder())->find($ast, static fn (Node $n) => $n instanceof Stmt\Use_ || $n instanceof Stmt\GroupUse) as $use) {
        foreach ($use->uses as $item) {
            $type = $use->type !== Stmt\Use_::TYPE_UNKNOWN ? $use->type : $item->type;
            $function = strtolower($item->name->getLast());
            if ($type === Stmt\Use_::TYPE_FUNCTION && in_array($function, NAME_SENSITIVE_FUNCTIONS, true)) {
                $names[strtolower($item->getAlias()->toString())] = $function;
            }
        }
    }

    return $names;
}

/**
 * 產生單一檔案的候選 mutation（尚未抽樣、尚未驗證）。
 *
 * @param list<Stmt> $ast
 * @return list<array{op: string, label: string, edits: list<array{0: int, 1: int, 2: string}>}>
 */
function candidateMutations(string $source, array $ast): array
{
    $finder = new NodeFinder();
    $mutations = [];
    $add = static function (string $op, string $label, array $edits) use (&$mutations, $source): void {
        foreach ($edits as [$start, $end, $replacement]) {
            if (substr($source, $start, $end - $start) !== $replacement) {
                $mutations[] = ['op' => $op, 'label' => $label, 'edits' => array_values($edits)];
                return;
            }
        }
    };

    // ---- safe：AST 不變 ----
    if ($statement = pick($finder->find($ast, static fn (Node $n) => $n instanceof Stmt && !$n instanceof Stmt\InlineHTML))) {
        $at = lineStart($source, $statement->getStartFilePos());
        preg_match('/^[ \t]*/', substr($source, $at), $indent);
        $add('S_COMMENT', 'safe', [[$at, $at, $indent[0] . "// reviewer mutation comment\n"]]);
    }

    $edits = [];
    $offset = 0;
    foreach (explode("\n", $source) as $line) {
        if (str_starts_with($line, '    ')) {
            $edits[] = [$offset, $offset + 4, "\t"];
        }
        $offset += strlen($line) + 1;
    }
    if ($edits !== []) {
        $add('S_REINDENT', 'safe', $edits);
    }

    $calls = $finder->find($ast, static fn (Node $n) => ($n instanceof Expr\MethodCall
        || $n instanceof Expr\StaticCall || $n instanceof Expr\FuncCall) && count($n->args) >= 2);
    if (($call = pick($calls)) && $call->args[1] instanceof Node\Arg) {
        $at = $call->args[1]->getStartFilePos();
        $add('S_WRAP_ARGS', 'safe', [[$at, $at, "\n            "]]);
    }

    $arrays = $finder->find($ast, static fn (Node $n) => $n instanceof Expr\Array_ && count($n->items) >= 1);
    if (($array = pick($arrays)) && ($last = end($array->items)) instanceof Node) {
        $end = $last->getEndFilePos() + 1;
        if (!preg_match('/^\s*,/', substr($source, $end, 64))) {
            $add('S_TRAILING_COMMA', 'safe', [[$end, $end, ',']]);
        }
    }

    $plainStrings = $finder->find($ast, static fn (Node $n) => $n instanceof Node\Scalar\String_
        && $n->getAttribute('kind') === Node\Scalar\String_::KIND_SINGLE_QUOTED
        && preg_match('/^[A-Za-z0-9_ .:\-]*$/', $n->value));
    if ($string = pick($plainStrings)) {
        [$start, $end] = span($string);
        $add('S_QUOTE_STYLE', 'safe', [[$start, $end, '"' . $string->value . '"']]);
    }

    // ---- risky：AST 改變 ----
    $callStatements = $finder->find($ast, static fn (Node $n) => $n instanceof Stmt\Expression
        && ($n->expr instanceof Expr\MethodCall || $n->expr instanceof Expr\StaticCall));
    if ($statement = pick($callStatements)) {
        [$start, $end] = span($statement);
        $add('R_REMOVE_CALL_STMT', 'risky', [[$start, $end, '']]);
    }

    $chained = $finder->find($ast, static fn (Node $n) => $n instanceof Expr\MethodCall
        && $n->var instanceof Expr\MethodCall && $n->var->name instanceof Node\Identifier);
    if ($call = pick($chained)) {
        // `X->inner(...)->outer()` → `X->outer()`
        $inner = $call->var;
        $add('R_REMOVE_CHAINED_CALL', 'risky', [[$inner->var->getEndFilePos() + 1, $inner->getEndFilePos() + 1, '']]);
    }

    if ($operator = pick($finder->find($ast, static fn (Node $n) => isset(OPERATOR_FLIPS[$n::class])))) {
        $from = $operator->left->getEndFilePos() + 1;
        $between = substr($source, $from, $operator->right->getStartFilePos() - $from);
        $sigil = $operator->getOperatorSigil();
        $position = strpos($between, $sigil);
        if ($position !== false) {
            $add('R_FLIP_OPERATOR', 'risky', [[$from + $position, $from + $position + strlen($sigil), OPERATOR_FLIPS[$operator::class]]]);
        }
    }

    $quotedStrings = $finder->find($ast, static fn (Node $n) => $n instanceof Node\Scalar\String_ && $n->value !== ''
        && in_array($n->getAttribute('kind'), [Node\Scalar\String_::KIND_SINGLE_QUOTED, Node\Scalar\String_::KIND_DOUBLE_QUOTED], true));
    if ($string = pick($quotedStrings)) {
        $closingQuote = $string->getEndFilePos();
        $add('R_CHANGE_STRING', 'risky', [[$closingQuote, $closingQuote, 'X']]);
    }

    if ($integer = pick($finder->find($ast, static fn (Node $n) => $n instanceof Node\Scalar\Int_))) {
        [$start, $end] = span($integer);
        $add('R_CHANGE_INT', 'risky', [[$start, $end, (string) ($integer->value + 1)]]);
    }

    if ($array = pick(array_filter($arrays, static fn (Expr\Array_ $a) => count($a->items) >= 2))) {
        $item = $array->items[mt_rand(0, count($array->items) - 2)];
        if ($item instanceof Node) {
            [$start, $end] = span($item);
            if (preg_match('/^\s*,\s*/', substr($source, $end, 256), $separator)) {
                $add('R_REMOVE_ARRAY_ITEM', 'risky', [[$start, $end + strlen($separator[0]), '']]);
            }
        }
    }

    if ($guard = pick($finder->find($ast, static fn (Node $n) => $n instanceof Stmt\If_ && isGuard($n)))) {
        [$start, $end] = span($guard);
        $add('R_REMOVE_GUARD', 'risky', [[$start, $end, '']]);
    }

    if ($if = pick($finder->findInstanceOf($ast, Stmt\If_::class))) {
        [$start, $end] = span($if->cond);
        $add('R_NEGATE_CONDITION', 'risky', [[$start, $start, '!('], [$end, $end, ')']]);
    }

    $swappable = array_filter($calls, static fn (Node $call) => $call->args[0] instanceof Node\Arg
        && $call->args[1] instanceof Node\Arg
        && $call->args[0]->name === null && $call->args[1]->name === null
        && !$call->args[0]->unpack && !$call->args[1]->unpack);
    if ($call = pick($swappable)) {
        [$start0, $end0] = span($call->args[0]);
        [$start1, $end1] = span($call->args[1]);
        $add('R_SWAP_ARGS', 'risky', [
            [$start0, $end0, substr($source, $start1, $end1 - $start1)],
            [$start1, $end1, substr($source, $start0, $end0 - $start0)],
        ]);
    }

    // 在 `__LINE__` 所在行之前插入一行：語法上只是註解，但 `__LINE__` 的值改變。
    if ($line = pick($finder->findInstanceOf($ast, Node\Scalar\MagicConst\Line::class))) {
        $at = lineStart($source, $line->getStartFilePos());
        $add('R_SHIFT_LINE', 'risky', [[$at, $at, "// reviewer mutation shifts __LINE__\n"]]);
    }

    if ($return = pick($finder->find($ast, static fn (Node $n) => $n instanceof Stmt\Return_ && $n->expr !== null))) {
        [$start, $end] = span($return);
        $add('R_RETURN_NULL', 'risky', [[$start, $end, 'return null;']]);
    }

    // ---- 區域變數改名 ----
    $methods = $finder->find($ast, static fn (Node $n) => $n instanceof Stmt\ClassMethod && $n->stmts !== null && $n->stmts !== []);
    if ($method = pick($methods)) {
        foreach (renameMutations($source, $method, sensitiveFunctionNames($ast)) as $mutation) {
            $add(...$mutation);
        }
    }

    return $mutations;
}

/**
 * 在單一 method 內產生改名 mutation：一致改名（safe）；部分改名、合併變數、參數改名、
 * compact() 以字串引用的變數改名、global 變數改名（risky）。
 *
 * @param array<string, string> $sensitiveFunctions sensitiveFunctionNames() 結果
 * @return list<array{0: string, 1: string, 2: list<array{0: int, 1: int, 2: string}>}>
 */
function renameMutations(string $source, Stmt\ClassMethod $method, array $sensitiveFunctions): array
{
    $finder = new NodeFinder();
    // 巢狀的 method / function（匿名 class、函式內宣告的函式）是獨立的變數 scope；
    // 跨 scope 的改名可能其實無害，會讓 risky 標籤失真，因此整個 method 不產生改名 mutation。
    if ($finder->findFirst($method->stmts, static fn (Node $n) => $n instanceof Stmt\ClassMethod || $n instanceof Stmt\Function_) !== null) {
        return [];
    }
    $sensitiveCalls = $finder->find($method, static fn (Node $n) => $n instanceof Expr\FuncCall
        && $n->name instanceof Node\Name
        && isset($sensitiveFunctions[strtolower($n->name->getLast())]));
    $nameSensitive = $sensitiveCalls !== [] || $finder->findFirst($method, static fn (Node $n) => ($n instanceof Expr\Variable && !is_string($n->name))
        || $n instanceof Expr\Eval_ || $n instanceof Expr\Include_ || $n instanceof Stmt\Global_) !== null;

    // compact('name', ['name2']) 以字串引用的變數名稱
    $compactNames = [];
    foreach ($sensitiveCalls as $call) {
        if ($sensitiveFunctions[strtolower($call->name->getLast())] !== 'compact') {
            continue;
        }
        foreach ($finder->findInstanceOf($call->args, Node\Scalar\String_::class) as $string) {
            $compactNames[$string->value] = true;
        }
    }
    $globalNames = [];
    foreach ($finder->findInstanceOf($method->stmts, Stmt\Global_::class) as $global) {
        foreach ($global->vars as $var) {
            if ($var instanceof Expr\Variable && is_string($var->name)) {
                $globalNames[$var->name] = true;
            }
        }
    }

    $parameters = [];
    foreach ($finder->findInstanceOf($method, Node\Param::class) as $parameter) {
        if ($parameter->var instanceof Expr\Variable && is_string($parameter->var->name)) {
            $parameters[$parameter->var->name] = true;
        }
    }

    // 只處理原始碼寫成 `$name` 的出現處（排除 `${name}` 等寫法），確保 edit 精確。
    $occurrences = [];
    $plain = [];
    foreach ($finder->findInstanceOf($method->stmts, Expr\Variable::class) as $variable) {
        if (!is_string($variable->name)) {
            continue;
        }
        [$start, $end] = span($variable);
        $occurrences[$variable->name][] = [$start, $end];
        $plain[$variable->name] = ($plain[$variable->name] ?? true)
            && substr($source, $start, $end - $start) === '$' . $variable->name;
    }

    $methodText = substr($source, $method->getStartFilePos(), $method->getEndFilePos() - $method->getStartFilePos() + 1);
    $locals = array_values(array_filter(array_keys($occurrences), static fn (string $name) => $plain[$name]
        && !isset($parameters[$name])
        && !isset($globalNames[$name])
        && !in_array($name, PRESERVED_VARIABLES, true)
        && !str_contains($methodText, $name . 'Renamed')));
    $renameAll = static fn (string $from, string $to): array => array_map(
        static fn (array $range) => [$range[0], $range[1], '$' . $to],
        $occurrences[$from],
    );

    $renamable = static fn (string $name): bool => ($plain[$name] ?? false)
        && !isset($parameters[$name])
        && !in_array($name, PRESERVED_VARIABLES, true)
        && !str_contains($methodText, $name . 'Renamed');

    $mutations = [];
    if (!$nameSensitive && ($variable = pick($locals))) {
        $mutations[] = ['S_RENAME_LOCAL', 'safe', $renameAll($variable, $variable . 'Renamed')];
    }
    if ($variable = pick(array_filter($locals, static fn (string $name) => count($occurrences[$name]) >= 2))) {
        $range = $occurrences[$variable][mt_rand(0, count($occurrences[$variable]) - 1)];
        $mutations[] = ['R_RENAME_PARTIAL', 'risky', [[$range[0], $range[1], '$' . $variable . 'Renamed']]];
    }
    if (count($locals) >= 2) {
        $pair = $locals;
        shuffle($pair);
        $mutations[] = ['R_RENAME_MERGE', 'risky', $renameAll($pair[1], $pair[0])];
    }
    $ownParameters = array_filter($method->params, static fn (Node\Param $p) => $p->var instanceof Expr\Variable
        && is_string($p->var->name) && ($plain[$p->var->name] ?? true));
    if ($parameter = pick($ownParameters)) {
        $name = $parameter->var->name;
        [$start, $end] = span($parameter->var);
        $mutations[] = ['R_RENAME_PARAM', 'risky', [
            [$start, $end, '$' . $name . 'Renamed'],
            ...array_map(static fn (array $range) => [$range[0], $range[1], '$' . $name . 'Renamed'], $occurrences[$name] ?? []),
        ]];
    }
    if ($variable = pick(array_filter(array_keys($compactNames), static fn ($name) => isset($occurrences[$name]) && $renamable($name)))) {
        $mutations[] = ['R_RENAME_COMPACT', 'risky', $renameAll($variable, $variable . 'Renamed')];
    }
    if ($variable = pick(array_filter(array_keys($globalNames), static fn ($name) => isset($occurrences[$name]) && $renamable($name)))) {
        $mutations[] = ['R_RENAME_GLOBAL', 'risky', $renameAll($variable, $variable . 'Renamed')];
    }

    return $mutations;
}

/**
 * 依 label 驗證 mutation。
 *
 * - safe（改名除外）：兩種語法下的可解析性都不變，且每種可解析的語法下 canonical print 都相同。
 * - S_RENAME_LOCAL：兩種語法下的可解析性都不變，且主要語法下 print 不同（改名確實發生）。
 * - risky：主要語法下 print 不同。
 *
 * @param array{op: string, label: string, edits: list<array{0: int, 1: int, 2: string}>} $mutation
 * @param array{newest: string|null, php74: string|null} $basePrints
 */
function validMutation(array $mutation, string $source, array $basePrints): bool
{
    $afterPrints = grammarPrints(applyEdits($source, $mutation['edits']));
    $primary = $basePrints['newest'] !== null ? 'newest' : 'php74';
    if ($basePrints[$primary] === null || $afterPrints[$primary] === null) {
        return false;
    }
    $sameParseability = ($basePrints['newest'] === null) === ($afterPrints['newest'] === null)
        && ($basePrints['php74'] === null) === ($afterPrints['php74'] === null);

    if ($mutation['op'] === 'S_RENAME_LOCAL') {
        return $sameParseability && $afterPrints[$primary] !== $basePrints[$primary];
    }
    if ($mutation['label'] === 'safe') {
        return $sameParseability
            && $afterPrints['newest'] === $basePrints['newest']
            && $afterPrints['php74'] === $basePrints['php74'];
    }

    return $afterPrints[$primary] !== $basePrints[$primary];
}

$stats = [
    'files' => 0, 'nonUtf8Path' => 0, 'unparsable' => 0, 'tooLarge' => 0,
    'unchanged' => 0, 'safe' => 0, 'risky' => 0, 'rejected' => 0,
];
$emit = static function (array $row) use (&$stats): void {
    $line = json_encode($row, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($line === false) {
        $stats['rejected'] += 1;
        return;
    }
    echo $line, "\n";
    $stats[$row['label']] += 1;
};

$files = listPhpFiles($root);
if ($files === []) {
    fwrite(STDERR, "no PHP files found in {$root}\n");
    exit(2);
}
foreach ($files as $file) {
    if (!mb_check_encoding($file, 'UTF-8')) {
        $stats['nonUtf8Path'] += 1;
        continue;
    }
    // git index 中仍存在、但 working tree 已刪除的檔案直接略過。
    $fullPath = rtrim($root, '/') . '/' . $file;
    $source = is_file($fullPath) ? file_get_contents($fullPath) : false;
    if (!is_string($source)) {
        continue;
    }
    $stats['files'] += 1;
    if (strlen($source) > MAX_FILE_BYTES) {
        $stats['tooLarge'] += 1;
        continue;
    }

    $base = ['repo' => $label, 'path' => $file, 'sourceSha256' => hash('sha256', $source)];
    // 與 analyzer 相同的主要語法：最新語法，無法解析時改用 PHP 7 視角。
    $grammars = $source === '' ? ['newest' => null, 'php74' => null] : parseBothGrammars($source);
    $ast = $grammars['newest'] ?? $grammars['php74'];
    $emit($base + ['op' => 'S_UNCHANGED', 'label' => 'unchanged', 'parseable' => $ast !== null, 'edits' => []]);
    if ($ast === null) {
        $stats['unparsable'] += 1;
        continue;
    }

    // 每個檔案以 seed 與路徑重設亂數；先抽樣再驗證，RNG 消耗只取決於檔案內容與 seed。
    mt_srand(crc32($seed . "\0" . $file));
    $sampled = array_filter(
        candidateMutations($source, $ast),
        static fn () => mt_rand() / mt_getrandmax() <= $rate,
    );
    if ($sampled === []) {
        continue;
    }

    $basePrints = grammarPrints($source);
    foreach ($sampled as $mutation) {
        // edit 的 replacement 必須是合法 UTF-8 才能寫進 JSONL；否則捨棄（不轉碼，避免改變 bytes）。
        $encodable = array_reduce($mutation['edits'], static fn (bool $ok, array $edit) => $ok && mb_check_encoding($edit[2], 'UTF-8'), true);
        if (!$encodable || !validMutation($mutation, $source, $basePrints)) {
            $stats['rejected'] += 1;
            continue;
        }
        $emit($base + $mutation);
    }
}

fwrite(STDERR, json_encode(['repo' => $label] + $stats, JSON_UNESCAPED_SLASHES) . "\n");
