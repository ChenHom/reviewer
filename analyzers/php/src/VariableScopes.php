<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Stmt;
use PhpParser\NodeFinder;

/**
 * 為 function-like scope 內的區域變數產生 canonical 名稱（`"\0rv0"`、`"\0rv1"`…），
 * 依第一次出現的順序編號。兩個只差在區域變數一致改名的函式會得到相同的
 * canonical 名稱序列，而不一致的改名（合併兩個變數、只改部分出現處）不會。
 *
 * 保守規則：
 * - 只處理 ClassMethod / Function_ / 頂層 Closure；巢狀 closure / arrow function
 *   併入外層 scope（`use` 與自動 capture 都以同一個名稱空間處理）。
 * - 參數（含巢狀 closure 參數）、`$this`、superglobal、PHP magic local、
 *   `global` 宣告的變數一律保留原名；頂層 code 的變數是 global，不改名。
 * - scope 內出現任何以字串存取變數名的機制（compact、extract、
 *   get_defined_vars、`$$x`、eval、include/require、單參數 parse_str），整個 scope 不改名。
 *   PHP 7.1 起這些函式不能被動態呼叫（`$fn('x')`），因此只需檢查直接呼叫。
 */
final class VariableScopes
{
    private const PRESERVED = [
        'this', 'GLOBALS', '_SERVER', '_GET', '_POST', '_FILES', '_COOKIE', '_SESSION',
        '_REQUEST', '_ENV', 'http_response_header', 'php_errormsg', 'argc', 'argv',
    ];

    private const NAME_SENSITIVE_FUNCTIONS = ['compact', 'extract', 'get_defined_vars', 'parse_str', 'mb_parse_str', 'assert'];

    /** @var array<int, string> spl_object_id(Variable) → canonical name */
    private array $names = [];

    /**
     * 小寫的可呼叫名稱 → 原始的 name-sensitive 函式名稱；包含 `use function compact as x` 的別名。
     *
     * @var array<string, string>
     */
    private array $sensitiveFunctions = [];

    /**
     * @param list<Stmt> $statements
     * @return array<int, string> spl_object_id(Variable) → canonical name
     */
    public static function canonicalNames(array $statements): array
    {
        $scopes = new self();
        $scopes->sensitiveFunctions = self::sensitiveFunctionNames($statements);
        $scopes->walkList($statements, false);

        return $scopes->names;
    }

    /**
     * @param array<mixed> $nodes
     */
    private function walkList(array $nodes, bool $insideFunction): void
    {
        foreach ($nodes as $node) {
            if ($node instanceof Node) {
                $this->walk($node, $insideFunction);
            } elseif (is_array($node)) {
                $this->walkList($node, $insideFunction);
            }
        }
    }

    private function walk(Node $node, bool $insideFunction): void
    {
        if ($node instanceof Stmt\ClassMethod || $node instanceof Stmt\Function_) {
            $this->canonicalizeScope($node, []);
            return;
        }
        if ($node instanceof Expr\Closure && !$insideFunction) {
            // 頂層 closure：`use` 變數綁定的是 global，保留原名。
            $useNames = [];
            foreach ($node->uses as $use) {
                if (is_string($use->var->name)) {
                    $useNames[] = $use->var->name;
                }
            }
            $this->canonicalizeScope($node, $useNames);
            return;
        }
        if ($node instanceof Expr\ArrowFunction && !$insideFunction) {
            // 頂層 arrow function 自動 capture global，不改名；但內部仍可能有 class method。
            $this->walkChildren($node, false);
            return;
        }

        $this->walkChildren($node, $insideFunction);
    }

    private function walkChildren(Node $node, bool $insideFunction): void
    {
        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($child instanceof Node) {
                $this->walk($child, $insideFunction);
            } elseif (is_array($child)) {
                $this->walkList($child, $insideFunction);
            }
        }
    }

    /**
     * @param list<string> $extraPreserved
     */
    private function canonicalizeScope(Stmt\ClassMethod|Stmt\Function_|Expr\Closure $root, array $extraPreserved): void
    {
        $body = $root->getStmts() ?? [];
        $preserved = array_fill_keys([...self::PRESERVED, ...$extraPreserved], true);
        $renamable = !$this->isNameSensitive($root);

        foreach ((new NodeFinder())->find($root, static fn (Node $n): bool => $n instanceof Node\Param) as $param) {
            if ($param->var instanceof Expr\Variable && is_string($param->var->name)) {
                $preserved[$param->var->name] = true;
            }
        }
        foreach ((new NodeFinder())->findInstanceOf($body, Stmt\Global_::class) as $global) {
            foreach ($global->vars as $var) {
                if ($var instanceof Expr\Variable && is_string($var->name)) {
                    $preserved[$var->name] = true;
                }
            }
        }

        $state = ['map' => [], 'next' => 0];
        // 參數預設值、attribute 等不在 body 內的部分也要走過，才能處理其中的 class method。
        foreach ($root->getSubNodeNames() as $name) {
            if ($name === 'stmts') {
                continue;
            }
            $child = $root->$name;
            if ($child instanceof Node) {
                $this->walk($child, true);
            } elseif (is_array($child)) {
                $this->walkList($child, true);
            }
        }
        $this->assignNames($body, $preserved, $renamable, $state);
    }

    /**
     * @param array<mixed> $nodes
     * @param array<string, true> $preserved
     * @param array{map: array<string, string>, next: int} $state
     */
    private function assignNames(array $nodes, array $preserved, bool $renamable, array &$state): void
    {
        foreach ($nodes as $node) {
            if (is_array($node)) {
                $this->assignNames($node, $preserved, $renamable, $state);
                continue;
            }
            if (!$node instanceof Node) {
                continue;
            }

            // 巢狀的具名 scope 各自獨立處理。
            if ($node instanceof Stmt\ClassMethod || $node instanceof Stmt\Function_) {
                $this->canonicalizeScope($node, []);
                continue;
            }

            if (
                $renamable
                && $node instanceof Expr\Variable
                && is_string($node->name)
                && !isset($preserved[$node->name])
            ) {
                // 以 NUL 開頭：不可能是合法的 PHP 變數名稱，不會與保留原名的變數（參數等）碰撞。
                $state['map'][$node->name] ??= "\0rv" . $state['next']++;
                $this->names[spl_object_id($node)] = $state['map'][$node->name];
            }

            foreach ($node->getSubNodeNames() as $name) {
                $child = $node->$name;
                if ($child instanceof Node || is_array($child)) {
                    $this->assignNames(is_array($child) ? $child : [$child], $preserved, $renamable, $state);
                }
            }
        }
    }

    private static function hasUnpackedArgument(Expr\FuncCall $call): bool
    {
        foreach ($call->args as $arg) {
            if (!$arg instanceof Node\Arg || $arg->unpack) {
                return true;
            }
        }

        return false;
    }

    /**
     * assert() 的參數是否必定不是字串（比較、邏輯運算、instanceof、isset、empty、true / false）。
     */
    private static function isNonStringAssertion(mixed $arg): bool
    {
        if (!$arg instanceof Node\Arg || $arg->unpack) {
            return false;
        }
        $value = $arg->value;
        $booleanOperators = [
            Expr\BinaryOp\Equal::class, Expr\BinaryOp\NotEqual::class, Expr\BinaryOp\Identical::class,
            Expr\BinaryOp\NotIdentical::class, Expr\BinaryOp\Smaller::class, Expr\BinaryOp\SmallerOrEqual::class,
            Expr\BinaryOp\Greater::class, Expr\BinaryOp\GreaterOrEqual::class, Expr\BinaryOp\BooleanAnd::class,
            Expr\BinaryOp\BooleanOr::class, Expr\BinaryOp\LogicalAnd::class, Expr\BinaryOp\LogicalOr::class,
            Expr\BinaryOp\LogicalXor::class,
        ];

        return in_array($value::class, $booleanOperators, true)
            || $value instanceof Expr\BooleanNot
            || $value instanceof Expr\Instanceof_
            || $value instanceof Expr\Isset_
            || $value instanceof Expr\Empty_
            || ($value instanceof Expr\ConstFetch && in_array(strtolower($value->name->toString()), ['true', 'false'], true));
    }

    /**
     * 收集檔案內所有指向 name-sensitive 函式的名稱（含 `use function` 別名與 group use）。
     *
     * @param list<Stmt> $statements
     * @return array<string, string> 小寫名稱 → 原始函式名稱
     */
    private static function sensitiveFunctionNames(array $statements): array
    {
        $names = array_combine(self::NAME_SENSITIVE_FUNCTIONS, self::NAME_SENSITIVE_FUNCTIONS);
        $uses = (new NodeFinder())->find(
            $statements,
            static fn (Node $node): bool => $node instanceof Stmt\Use_ || $node instanceof Stmt\GroupUse,
        );
        foreach ($uses as $use) {
            foreach ($use->uses as $item) {
                $type = $use->type !== Stmt\Use_::TYPE_UNKNOWN ? $use->type : $item->type;
                $function = strtolower($item->name->getLast());
                if ($type === Stmt\Use_::TYPE_FUNCTION && in_array($function, self::NAME_SENSITIVE_FUNCTIONS, true)) {
                    $names[strtolower($item->getAlias()->toString())] = $function;
                }
            }
        }

        return $names;
    }

    /**
     * scope 內是否有以字串存取變數名稱的機制。
     */
    private function isNameSensitive(Node $root): bool
    {
        $sensitive = $this->sensitiveFunctions;

        return (new NodeFinder())->findFirst($root, static function (Node $node) use ($sensitive): bool {
            if ($node instanceof Expr\Variable && !is_string($node->name)) {
                return true;
            }
            if ($node instanceof Expr\Eval_ || $node instanceof Expr\Include_) {
                return true;
            }
            if ($node instanceof Expr\FuncCall && $node->name instanceof Node\Name) {
                $function = $sensitive[strtolower($node->name->getLast())] ?? null;
                if ($function === null) {
                    return false;
                }
                // parse_str / mb_parse_str 只有單參數時才會寫入區域變數（spread 可能讓實際參數只有一個）。
                if (in_array($function, ['parse_str', 'mb_parse_str'], true)) {
                    return count($node->args) < 2 || self::hasUnpackedArgument($node);
                }
                // PHP 7 的 assert() 會把字串參數當成程式碼在目前 scope 執行。
                if ($function === 'assert') {
                    return !self::isNonStringAssertion($node->args[0] ?? null);
                }

                return true;
            }

            return false;
        }) !== null;
    }
}
