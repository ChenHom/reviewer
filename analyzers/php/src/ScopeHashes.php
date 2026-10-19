<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

use PhpParser\Node;
use PhpParser\Node\Stmt;

/**
 * head 版本中每個 method / function 的 canonical AST hash（二次 review 的人工豁免綁定在這個 hash 上）。
 *
 * subject 的命名與 CallExtractor / StructuralDiff 相同（`Class::method`、匿名 class 的 method 只有名稱、
 * function 名稱）。hash 使用 head 的 scope-aware canonical 變數名稱，所以排版、註解與一致的區域變數
 * 改名不會改變 hash。同一個 subject 對應多個 node 時（例如兩個匿名 class 有同名 method）合併成一個 hash。
 */
final class ScopeHashes
{
    /** @var array<string, list<string>> subject → node hashes */
    private array $hashes = [];

    private function __construct(private readonly Canonicalizer $hasher)
    {
    }

    /**
     * @param list<Stmt> $statements head AST。
     * @return array{scopes: array<string, string>, file: string} subject → hash，以及整個檔案的 hash。
     */
    public static function compute(array $statements): array
    {
        $hasher = new Canonicalizer(VariableScopes::canonicalNames($statements));
        $collector = new self($hasher);
        $collector->walkList($statements, null);

        $scopes = [];
        foreach ($collector->hashes as $subject => $hashes) {
            $scopes[$subject] = count($hashes) === 1 ? $hashes[0] : hash('xxh128', implode("\x1f", $hashes));
        }

        return ['scopes' => $scopes, 'file' => $hasher->hash($statements)];
    }

    /**
     * 每個 fact 加上 `properties.scope`：所屬 method / function 的 hash（`kind: function`），
     * 不在 method / function 內或 head 中已不存在時為整個檔案的 hash（`kind: file`）。
     *
     * @param list<array<string, mixed>> $facts
     * @param list<Stmt> $statements head AST。
     * @return list<array<string, mixed>>
     */
    public static function annotate(array $facts, array $statements): array
    {
        if ($facts === []) {
            return $facts;
        }
        ['scopes' => $scopes, 'file' => $file] = self::compute($statements);

        return array_map(static function (array $fact) use ($scopes, $file): array {
            $hash = $scopes[$fact['subject']] ?? null;
            $fact['properties']['scope'] = $hash === null
                ? ['kind' => 'file', 'hash' => 'php:' . $file]
                : ['kind' => 'function', 'hash' => 'php:' . $hash];
            return $fact;
        }, $facts);
    }

    /**
     * @param array<mixed> $nodes
     */
    private function walkList(array $nodes, ?string $class): void
    {
        foreach ($nodes as $node) {
            if ($node instanceof Node) {
                $this->walk($node, $class);
            } elseif (is_array($node)) {
                $this->walkList($node, $class);
            }
        }
    }

    private function walk(Node $node, ?string $class): void
    {
        if ($node instanceof Stmt\ClassLike) {
            $class = $node->name?->toString();
        } elseif ($node instanceof Stmt\ClassMethod || $node instanceof Stmt\Function_) {
            $function = $node->name->toString();
            $this->hashes[$class !== null ? $class . '::' . $function : $function][] = $this->hasher->hash($node);
        }

        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($child instanceof Node) {
                $this->walk($child, $class);
            } elseif (is_array($child)) {
                $this->walkList($child, $class);
            }
        }
    }
}
