<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Stmt;
use PhpParser\NodeFinder;

/**
 * 為 function-like scope 內的區域變數產生 canonical 名稱（`$__rv0`、`$__rv1`…），
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

    private const NAME_SENSITIVE_FUNCTIONS = ['compact', 'extract', 'get_defined_vars', 'parse_str', 'mb_parse_str'];

    /** @var array<int, string> spl_object_id(Variable) → canonical name */
    private array $names = [];

    /**
     * @param list<Stmt> $statements
     * @return array<int, string> spl_object_id(Variable) → canonical name
     */
    public static function canonicalNames(array $statements): array
    {
        $scopes = new self();
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
        $renamable = !self::isNameSensitive($root);

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
                $state['map'][$node->name] ??= '__rv' . $state['next']++;
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

    /**
     * scope 內是否有以字串存取變數名稱的機制。
     */
    private static function isNameSensitive(Node $root): bool
    {
        return (new NodeFinder())->findFirst($root, static function (Node $node): bool {
            if ($node instanceof Expr\Variable && !is_string($node->name)) {
                return true;
            }
            if ($node instanceof Expr\Eval_ || $node instanceof Expr\Include_) {
                return true;
            }
            if ($node instanceof Expr\FuncCall && $node->name instanceof Node\Name) {
                $function = strtolower($node->name->getLast());
                if (!in_array($function, self::NAME_SENSITIVE_FUNCTIONS, true)) {
                    return false;
                }
                // parse_str / mb_parse_str 只有單參數時才會寫入區域變數。
                return !in_array($function, ['parse_str', 'mb_parse_str'], true) || count($node->args) < 2;
            }

            return false;
        }) !== null;
    }
}
