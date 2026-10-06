<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

use PhpParser\Node;
use PhpParser\Node\Stmt;

/**
 * 產生 AST 的 canonical hash：只看 node 類型與 sub-node，不看 attributes。
 *
 * 因此排版、註解、trailing comma、引號種類、`array()` / `[]`、多餘括號
 * 等不影響語意的差異都會得到相同 hash；任何 sub-node 值不同都會不同。
 */
final class Canonicalizer
{
    /** @var array<int, string> spl_object_id → hash */
    private array $cache = [];

    /**
     * @param array<int, string> $variableNames spl_object_id(Variable) → canonical 區域變數名稱
     *        （見 VariableScopes）；未列出的變數使用原名。
     */
    public function __construct(private readonly array $variableNames = [])
    {
    }

    /**
     * 回傳變數的 canonical 名稱（不含 `$`）；不可改名的變數回傳原名。
     */
    public function variableName(Node\Expr\Variable $variable): ?string
    {
        if (!is_string($variable->name)) {
            return null;
        }

        return $this->variableNames[spl_object_id($variable)] ?? $variable->name;
    }

    public function hash(mixed $value): string
    {
        if ($value instanceof Node) {
            $id = spl_object_id($value);
            return $this->cache[$id] ??= hash('xxh128', $this->serialize($value));
        }
        if (is_array($value)) {
            return hash('xxh128', $this->serializeList($value));
        }

        return hash('xxh128', $this->scalar($value));
    }

    private function serialize(Node $node): string
    {
        $parts = [$node::class];
        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($name === 'name' && $node instanceof Node\Expr\Variable && isset($this->variableNames[spl_object_id($node)])) {
                $child = $this->variableNames[spl_object_id($node)];
            }
            $parts[] = $name . '=' . match (true) {
                $child instanceof Node => $this->hash($child),
                is_array($child) => $this->serializeList($child),
                default => $this->scalar($child),
            };
        }

        return implode("\x1f", $parts);
    }

    /**
     * @param array<mixed> $items
     */
    private function serializeList(array $items): string
    {
        $parts = [];
        foreach (self::significant($items) as $key => $item) {
            $parts[] = (is_int($key) ? '' : $key . ':') . match (true) {
                $item instanceof Node => $this->hash($item),
                is_array($item) => $this->serializeList($item),
                default => $this->scalar($item),
            };
        }

        return '[' . implode("\x1e", $parts) . ']';
    }

    private function scalar(mixed $value): string
    {
        return get_debug_type($value) . ':' . var_export($value, true);
    }

    /**
     * 移除只承載註解的 `Stmt\Nop`，其餘保持原順序（list 會重新編號）。
     *
     * @param array<mixed> $items
     * @return array<mixed>
     */
    public static function significant(array $items): array
    {
        if (!array_is_list($items)) {
            return $items;
        }

        return array_values(array_filter($items, static fn (mixed $item): bool => !$item instanceof Stmt\Nop));
    }
}
