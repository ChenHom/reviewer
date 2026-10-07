<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

use PhpParser\Node;
use PhpParser\NodeFinder;
use PhpParser\Node\Expr;
use PhpParser\Node\Scalar;
use PhpParser\Node\Stmt;

/**
 * 以 AST 結構比對 before / after，判定 completeness 並產生結構性 facts。
 *
 * Soundness 規則：每個被「解釋」的差異，都必須消耗一個既有 call fact
 * （CALL_REMOVED / CALL_ADDED / named CALL_ARGUMENT_CHANGED），或產生一個新的
 * fact。因此 `complete === true && facts === []` 只可能發生在兩棵 AST 的
 * canonical hash 完全相同時。
 */
final class StructuralDiff
{
    /** @var list<array<string, mixed>> */
    private array $facts = [];

    /** @var list<array{string, int}> 未解釋差異（描述, before byte offset） */
    private array $unexplained = [];

    /** @var array<string, int> fact budget：kind|subject|callee(|argument) → 可消耗次數 */
    private array $budget = [];

    /** 已消耗的 call fact 次數（與 $facts 一起構成「已解釋」的證據） */
    private int $consumed = 0;

    private Canonicalizer $beforeHasher;

    private Canonicalizer $afterHasher;

    private ?string $class = null;

    private ?string $function = null;

    /**
     * @param array<int, array<string, mixed>> $beforeCalls spl_object_id → call record
     * @param array<int, array<string, mixed>> $afterCalls spl_object_id → call record
     * @param list<array<string, mixed>> $callFacts 由 call grouping 產生的 facts
     * @param bool $explainVariables 變數名稱不同時輸出 VARIABLE_CHANGED（只在原始名稱比較時使用）
     */
    public function __construct(
        private readonly string $path,
        private readonly string $beforeSource,
        private readonly string $afterSource,
        private readonly array $beforeCalls,
        private readonly array $afterCalls,
        array $callFacts,
        ?Canonicalizer $beforeHasher = null,
        ?Canonicalizer $afterHasher = null,
        private readonly bool $explainVariables = false,
    ) {
        $this->beforeHasher = $beforeHasher ?? new Canonicalizer();
        $this->afterHasher = $afterHasher ?? new Canonicalizer();

        foreach ($callFacts as $fact) {
            $key = self::budgetKey(
                $fact['kind'],
                $fact['subject'],
                $fact['calleeKey'],
                $fact['properties']['argument'] ?? null,
            );
            $this->budget[$key] = ($this->budget[$key] ?? 0) + 1;
        }
    }

    /**
     * @param list<Stmt> $before
     * @param list<Stmt> $after
     * @return array{facts: list<array<string, mixed>>, unexplained: list<array{string, int}>}
     */
    public function run(array $before, array $after): array
    {
        $this->compareList($before, $after, 'stmts', 'file');

        // Soundness 不變式：AST 不同時，必須至少有一個差異被 fact 解釋或被標為未解釋。
        // 防止遞迴比對與 canonical hash 的判斷標準不一致時，把不同的程式判為無 fact 的 COMPLETE。
        if (
            $this->unexplained === []
            && $this->facts === []
            && $this->consumed === 0
            && !$this->same($before, $after)
        ) {
            $this->unexplained('invariant', null);
        }

        return ['facts' => $this->facts, 'unexplained' => $this->unexplained];
    }

    private static function budgetKey(string $kind, string $subject, string $callee, ?string $argument): string
    {
        return implode("\x1f", [$kind, $subject, $callee, $argument ?? '']);
    }

    private function consume(string $kind, array $call, ?string $argument = null): bool
    {
        $key = self::budgetKey($kind, $call['subject'], $call['calleeKey'], $argument);
        if (($this->budget[$key] ?? 0) < 1) {
            return false;
        }
        $this->budget[$key] -= 1;
        $this->consumed += 1;

        return true;
    }

    /**
     * 同一位置的 call 換成另一個 method：同時消耗 before 的 CALL_REMOVED 與 after 的 CALL_ADDED；
     * 任一個沒有預算時兩個都不消耗。
     */
    private function consumeReplacement(array $beforeCall, array $afterCall): bool
    {
        $removed = self::budgetKey('CALL_REMOVED', $beforeCall['subject'], $beforeCall['calleeKey'], null);
        $added = self::budgetKey('CALL_ADDED', $afterCall['subject'], $afterCall['calleeKey'], null);
        if (($this->budget[$removed] ?? 0) < 1 || ($this->budget[$added] ?? 0) < 1) {
            return false;
        }

        return $this->consume('CALL_REMOVED', $beforeCall) && $this->consume('CALL_ADDED', $afterCall);
    }

    private function same(mixed $before, mixed $after): bool
    {
        return $this->beforeHasher->hash($before) === $this->afterHasher->hash($after);
    }

    private function unexplained(string $what, ?Node $before): void
    {
        $this->unexplained[] = [$what, $before?->getStartFilePos() ?? -1];
    }

    private function compare(mixed $before, mixed $after, string $container): void
    {
        if ($this->same($before, $after)) {
            return;
        }

        if (is_array($before) && is_array($after)) {
            $this->compareList($before, $after, 'list', $container);
            return;
        }

        if (!$before instanceof Node || !$after instanceof Node) {
            $this->unexplained('scalar', $before instanceof Node ? $before : null);
            return;
        }

        // 字面值（數字、字串、true / false / null）換成另一個字面值。
        if (self::isLiteral($before) && self::isLiteral($after)) {
            $this->addFact('LITERAL_CHANGED', $after, $this->afterSource, [
                'container' => $container,
                'before' => $this->text($before, $this->beforeSource),
                'after' => $this->text($after, $this->afterSource),
                'changeSide' => 'after',
            ]);
            return;
        }

        if ($before::class !== $after::class) {
            $this->compareDifferentTypes($before, $after, $container);
            return;
        }

        // Variable 的 hash 用 canonical 名稱（VariableScopes）；hash 不同時不可再遞迴比較原始名稱字串。
        // 只有以原始名稱比較時（hash 就是原名），才能把名稱差異描述成 VARIABLE_CHANGED。
        if ($before instanceof Expr\Variable) {
            if ($this->explainVariables && is_string($before->name) && is_string($after->name)) {
                $this->addFact('VARIABLE_CHANGED', $after, $this->afterSource, [
                    'container' => $container,
                    'before' => '$' . $before->name,
                    'after' => '$' . $after->name,
                    'changeSide' => 'after',
                ]);
                return;
            }
            $this->unexplained('variable', $before);
            return;
        }

        if ($this->isCall($before)) {
            // 被移除（或新增）的 call 與鄰近的 call 同類型時（`X->a()->b()` → `X->b()`），
            // 先以鏈的增減解釋，否則逐一比較 receiver、名稱與參數。
            if (!$this->explainChainChange($before, $after)) {
                $this->compareCalls($before, $after, $container);
            }
            return;
        }

        if (
            ($before instanceof Expr\FuncCall || $before instanceof Expr\New_)
            && $this->argumentsReordered($before->args, $after->args)
        ) {
            foreach ($before->getSubNodeNames() as $name) {
                if ($name !== 'args') {
                    $this->compare($before->$name, $after->$name, $container);
                }
            }
            $this->addReorderFact($before, $after, $this->calleeText($after, $this->afterSource), null);
            return;
        }

        if ($before instanceof Stmt\Return_) {
            $this->compareReturn($before, $after);
            return;
        }

        [$savedClass, $savedFunction] = [$this->class, $this->function];
        if ($before instanceof Stmt\ClassLike) {
            $this->class = $before->name?->toString();
            $this->function = null;
        } elseif ($before instanceof Stmt\ClassMethod || $before instanceof Stmt\Function_) {
            $this->function = $before->name->toString();
        }

        $progress = $this->progress();
        foreach ($before->getSubNodeNames() as $name) {
            $this->compare($before->$name, $after->$name, $this->childContainer($before, $name, $container));
        }
        // hash 不同、但子節點比較沒有找到任何差異：差異來自 hash 額外納入的資料
        // （canonical 變數名稱、`__LINE__` 行號等），必須視為未解釋。
        if ($this->progress() === $progress) {
            $this->unexplained('hash-only', $before);
        }

        [$this->class, $this->function] = [$savedClass, $savedFunction];
    }

    private function progress(): string
    {
        return count($this->unexplained) . ':' . count($this->facts) . ':' . $this->consumed;
    }

    private function subject(): string
    {
        if ($this->class !== null && $this->function !== null) {
            return $this->class . '::' . $this->function;
        }

        return $this->function ?? $this->path;
    }

    private function compareDifferentTypes(Node $before, Node $after, string $container): void
    {
        // `X` ↔ `!X`：整個運算式被反轉。
        if (
            ($after instanceof Expr\BooleanNot && $this->same($before, $after->expr))
            || ($before instanceof Expr\BooleanNot && $this->same($before->expr, $after))
        ) {
            $this->addFact('EXPRESSION_NEGATED', $after, $this->afterSource, [
                'container' => $container,
                'before' => $this->text($before, $this->beforeSource),
                'after' => $this->text($after, $this->afterSource),
                'changeSide' => 'after',
            ]);
            return;
        }

        if (
            $before instanceof Expr\BinaryOp
            && $after instanceof Expr\BinaryOp
            && $this->same($before->left, $after->left)
            && $this->same($before->right, $after->right)
        ) {
            $this->addFact('BINARY_OPERATOR_CHANGED', $after, $this->afterSource, [
                'operatorBefore' => $before->getOperatorSigil(),
                'operatorAfter' => $after->getOperatorSigil(),
                'before' => $this->text($before, $this->beforeSource),
                'after' => $this->text($after, $this->afterSource),
                'changeSide' => 'after',
            ]);
            return;
        }

        if ($this->explainChainChange($before, $after)) {
            return;
        }

        $this->unexplained('node-type', $before);
    }

    /**
     * 鏈中移除或新增一個 call，由對應的 CALL_REMOVED / CALL_ADDED 解釋。
     */
    private function explainChainChange(Node $before, Node $after): bool
    {
        // 鏈中移除一個 call：`X->inner()->outer()` → `X->outer()`（`before` 是被移除的 inner）
        if ($this->isCall($before) && $this->receiverOf($before) !== null && $this->same($this->receiverOf($before), $after)) {
            $call = $this->beforeCalls[spl_object_id($before)] ?? null;
            if ($call !== null && $this->consume('CALL_REMOVED', $call)) {
                return true;
            }
        }
        // 鏈中新增一個 call：`X->outer()` → `X->inner()->outer()`
        if ($this->isCall($after) && $this->receiverOf($after) !== null && $this->same($before, $this->receiverOf($after))) {
            $call = $this->afterCalls[spl_object_id($after)] ?? null;
            if ($call !== null && $this->consume('CALL_ADDED', $call)) {
                return true;
            }
        }

        return false;
    }

    private function compareCalls(Node $before, Node $after, string $container): void
    {
        $beforeCall = $this->beforeCalls[spl_object_id($before)] ?? null;
        $afterCall = $this->afterCalls[spl_object_id($after)] ?? null;

        // 同一位置換成另一個 method（`->first()` → `->firstOrFail()`）：由兩邊的
        // CALL_REMOVED / CALL_ADDED 解釋 method 名稱的差異，receiver 與參數仍照常比較。
        $nameExplained = $beforeCall !== null
            && $afterCall !== null
            && !$this->same($before->name, $after->name)
            && $beforeCall['calleeKey'] !== $afterCall['calleeKey']
            && $this->consumeReplacement($beforeCall, $afterCall);

        foreach ($before->getSubNodeNames() as $name) {
            if ($name !== 'args' && !($name === 'name' && $nameExplained)) {
                $this->compare($before->$name, $after->$name, $container);
            }
        }

        $beforeArgs = $before->args;
        $afterArgs = $after->args;
        if (count($beforeArgs) !== count($afterArgs)) {
            $this->unexplained('argument-count', $before);
            return;
        }

        if ($this->argumentsReordered($beforeArgs, $afterArgs)) {
            $this->addReorderFact(
                $before,
                $after,
                $afterCall['callee'] ?? $this->calleeText($after, $this->afterSource),
                $afterCall['subject'] ?? null,
            );
            return;
        }

        foreach ($beforeArgs as $index => $beforeArg) {
            $afterArg = $afterArgs[$index];
            if ($this->same($beforeArg, $afterArg)) {
                continue;
            }
            if (!$beforeArg instanceof Node\Arg || !$afterArg instanceof Node\Arg) {
                $this->unexplained('argument', $before);
                continue;
            }

            $beforeName = $beforeArg->name?->toString();
            $afterName = $afterArg->name?->toString();
            if ($beforeName !== $afterName || $beforeArg->unpack !== $afterArg->unpack || $beforeArg->byRef !== $afterArg->byRef) {
                $this->unexplained('argument-shape', $before);
                continue;
            }

            if ($beforeName !== null) {
                if ($afterCall !== null && $this->consume('CALL_ARGUMENT_CHANGED', $afterCall, $beforeName)) {
                    continue;
                }
                $this->compare($beforeArg->value, $afterArg->value, $this->argumentContainer($afterCall, $beforeName));
                continue;
            }

            $unexplainedBefore = count($this->unexplained);
            $this->compare($beforeArg->value, $afterArg->value, $this->argumentContainer($afterCall, '#' . $index));
            if (
                count($this->unexplained) > $unexplainedBefore
                && $afterCall !== null
                && $beforeCall !== null
                && !self::containsCallback($beforeArg)
                && !self::containsCallback($afterArg)
            ) {
                // 位置參數無法被更細的 fact 解釋：輸出 fallback fact（不視為已解釋）。
                $this->addFact('CALL_ARGUMENT_CHANGED', $afterArg, $this->afterSource, [
                    'callee' => $afterCall['callee'],
                    'argument' => '#' . $index,
                    'before' => $this->text($beforeArg, $this->beforeSource),
                    'after' => $this->text($afterArg, $this->afterSource),
                    'changeSide' => 'after',
                ], $afterCall['subject']);
            }
        }
    }

    /**
     * @param array<mixed> $before
     * @param array<mixed> $after
     */
    private function compareList(array $before, array $after, string $kind, string $container): void
    {
        $before = Canonicalizer::significant($before);
        $after = Canonicalizer::significant($after);

        if (!array_is_list($before) || !array_is_list($after)) {
            $this->unexplained('map', null);
            return;
        }

        $beforeHashes = array_map(fn ($node) => $this->beforeHasher->hash($node), $before);
        $afterHashes = array_map(fn ($node) => $this->afterHasher->hash($node), $after);
        $pairs = self::lcs($beforeHashes, $afterHashes);
        $pairs[] = [count($before), count($after)];

        $beforeIndex = 0;
        $afterIndex = 0;
        foreach ($pairs as [$anchorBefore, $anchorAfter]) {
            $this->compareGap(
                array_slice($before, $beforeIndex, $anchorBefore - $beforeIndex),
                array_slice($after, $afterIndex, $anchorAfter - $afterIndex),
                $container,
            );
            $beforeIndex = $anchorBefore + 1;
            $afterIndex = $anchorAfter + 1;
        }
    }

    /**
     * @param list<mixed> $removed
     * @param list<mixed> $added
     */
    private function compareGap(array $removed, array $added, string $container): void
    {
        // 運算式 list（`for` 條件、`echo`、`isset` 等）中一對一替換：直接比較兩個運算式。
        if (
            count($removed) === 1
            && count($added) === 1
            && $removed[0] instanceof Expr
            && $added[0] instanceof Expr
            && !$this->pairable($removed[0], $added[0])
        ) {
            $this->compare($removed[0], $added[0], $container);
            return;
        }

        $usedAdded = [];
        $unpairedRemoved = [];

        foreach ($removed as $item) {
            $match = null;
            foreach ($added as $index => $candidate) {
                if (!isset($usedAdded[$index]) && $this->pairable($item, $candidate)) {
                    $match = $index;
                    break;
                }
            }
            if ($match === null) {
                $unpairedRemoved[] = $item;
                continue;
            }
            $usedAdded[$match] = true;
            $this->compare($item, $added[$match], $container);
        }

        foreach ($unpairedRemoved as $item) {
            $this->explainListChange($item, 'before', $container);
        }
        foreach ($added as $index => $item) {
            if (!isset($usedAdded[$index])) {
                $this->explainListChange($item, 'after', $container);
            }
        }
    }

    private function pairable(mixed $before, mixed $after): bool
    {
        if (!$before instanceof Node || !$after instanceof Node || $before::class !== $after::class) {
            return false;
        }
        // 帶 key 的 array item 只和同 key 配對。
        if ($before instanceof Node\ArrayItem) {
            return $this->same($before->key, $after->key);
        }
        // 獨立 call statement 在 gap 中出現時不和不同 callee 配對，交給 CALL_REMOVED / CALL_ADDED 解釋。
        if ($before instanceof Stmt\Expression && $this->isCall($before->expr) && $this->isCall($after->expr)) {
            $beforeCall = $this->beforeCalls[spl_object_id($before->expr)] ?? null;
            $afterCall = $this->afterCalls[spl_object_id($after->expr)] ?? null;
            return $beforeCall !== null && $afterCall !== null && $beforeCall['calleeKey'] === $afterCall['calleeKey'];
        }
        foreach (['name'] as $identity) {
            if (property_exists($before, $identity) && $before->$identity instanceof Node && !$before instanceof Expr) {
                return $this->same($before->$identity, $after->$identity);
            }
        }

        return true;
    }

    private function explainListChange(mixed $item, string $side, string $container): void
    {
        $calls = $side === 'before' ? $this->beforeCalls : $this->afterCalls;
        $source = $side === 'before' ? $this->beforeSource : $this->afterSource;

        if ($item instanceof Stmt\Expression && $this->isCall($item->expr)) {
            $call = $calls[spl_object_id($item->expr)] ?? null;
            $kind = $side === 'before' ? 'CALL_REMOVED' : 'CALL_ADDED';
            if ($call !== null && !$call['hasCallbackBody'] && $this->consume($kind, $call)) {
                return;
            }
        }

        if ($item instanceof Stmt\If_ && ($exit = self::guardExit($item)) !== null) {
            $this->addFact($side === 'before' ? 'GUARD_REMOVED' : 'GUARD_ADDED', $item, $source, [
                'condition' => $this->text($item->cond, $source),
                'exit' => $exit,
                'changeSide' => $side,
            ]);
            return;
        }

        if ($item instanceof Node\ArrayItem) {
            $this->addFact($side === 'before' ? 'ARRAY_ITEM_REMOVED' : 'ARRAY_ITEM_ADDED', $item, $source, [
                'container' => $container,
                'key' => $item->key === null ? null : $this->text($item->key, $source),
                'value' => $this->text($item->value, $source),
                'changeSide' => $side,
            ]);
            return;
        }

        $this->unexplained('list-' . $side, $item instanceof Node ? $item : null);
    }

    /**
     * `return` 的值改變：先嘗試以更細的 fact 解釋；仍有未解釋差異、且其中一邊是常數
     * （`return null;`、`return false;`、`return [];`、`return;` 等）時，整個回傳值的替換
     * 以 RETURN_VALUE_CHANGED 解釋。兩邊都不是常數時維持未解釋。
     */
    private function compareReturn(Stmt\Return_ $before, Stmt\Return_ $after): void
    {
        $progress = $this->progress();
        if ($before->expr === null || $after->expr === null) {
            $this->addFact('RETURN_VALUE_CHANGED', $after->expr ?? $after, $this->afterSource, [
                'before' => $before->expr === null ? '' : $this->text($before->expr, $this->beforeSource),
                'after' => $after->expr === null ? '' : $this->text($after->expr, $this->afterSource),
                'changeSide' => 'after',
            ]);
            return;
        }

        $mark = count($this->unexplained);
        $this->compare($before->expr, $after->expr, 'return');
        if (count($this->unexplained) > $mark && (self::isConstant($before->expr) || self::isConstant($after->expr))) {
            array_splice($this->unexplained, $mark);
            $this->addFact('RETURN_VALUE_CHANGED', $after->expr, $this->afterSource, [
                'before' => $this->text($before->expr, $this->beforeSource),
                'after' => $this->text($after->expr, $this->afterSource),
                'changeSide' => 'after',
            ]);
        }
        if ($this->progress() === $progress) {
            $this->unexplained('hash-only', $before);
        }
    }

    /**
     * 參數只有順序不同：數量相同（至少兩個）、內容的 multiset 相同、順序不同。
     *
     * @param array<Node> $before
     * @param array<Node> $after
     */
    private function argumentsReordered(array $before, array $after): bool
    {
        if (count($before) < 2 || count($before) !== count($after)) {
            return false;
        }
        $beforeHashes = array_map(fn ($arg) => $this->beforeHasher->hash($arg), $before);
        $afterHashes = array_map(fn ($arg) => $this->afterHasher->hash($arg), $after);
        if ($beforeHashes === $afterHashes) {
            return false;
        }
        sort($beforeHashes);
        sort($afterHashes);

        return $beforeHashes === $afterHashes;
    }

    private function addReorderFact(Node $before, Node $after, string $callee, ?string $subject): void
    {
        $join = fn (array $args, string $source): string => implode(', ', array_map(
            fn (Node $arg): string => $this->text($arg, $source),
            $args,
        ));
        $this->addFact('CALL_ARGUMENTS_REORDERED', $after, $this->afterSource, [
            'callee' => $callee,
            'before' => $join($before->args, $this->beforeSource),
            'after' => $join($after->args, $this->afterSource),
            'changeSide' => 'after',
        ], $subject);
    }

    /**
     * 沒有 call record 的 call（function call、`new`、不支援的 receiver）的名稱文字。
     */
    private function calleeText(Node $call, string $source): string
    {
        return match (true) {
            $call instanceof Expr\FuncCall => $this->text($call->name, $source),
            $call instanceof Expr\New_ => 'new ' . ($call->class instanceof Stmt\Class_ ? 'class' : $this->text($call->class, $source)),
            $call instanceof Expr\StaticCall => $this->text($call->class, $source) . '::' . $this->text($call->name, $source),
            default => '->' . $this->text($call->name, $source),
        };
    }

    /**
     * 字面值：數字、非插值字串、true / false / null，以及帶正負號的數字。
     */
    private static function isLiteral(Node $node): bool
    {
        if ($node instanceof Expr\UnaryMinus || $node instanceof Expr\UnaryPlus) {
            return $node->expr instanceof Scalar\Int_ || $node->expr instanceof Scalar\Float_;
        }

        return $node instanceof Scalar\Int_
            || $node instanceof Scalar\Float_
            || $node instanceof Scalar\String_
            || ($node instanceof Expr\ConstFetch && in_array($node->name->toLowerString(), ['true', 'false', 'null'], true));
    }

    /**
     * 編譯期即可決定的值：字面值、常數、class 常數 / enum case，以及只含這些值的陣列。
     */
    private static function isConstant(Node $node): bool
    {
        if (self::isLiteral($node) || $node instanceof Expr\ConstFetch) {
            return true;
        }
        if ($node instanceof Expr\ClassConstFetch) {
            return $node->class instanceof Node\Name && $node->name instanceof Node\Identifier;
        }
        if ($node instanceof Expr\Array_) {
            foreach ($node->items as $item) {
                if (
                    !$item instanceof Node\ArrayItem
                    || $item->byRef
                    || $item->unpack
                    || ($item->key !== null && !self::isConstant($item->key))
                    || !self::isConstant($item->value)
                ) {
                    return false;
                }
            }
            return true;
        }

        return false;
    }

    /**
     * Early-exit guard：沒有 else / elseif，body 只有一個 throw / return / exit。
     */
    public static function guardExit(Stmt\If_ $if): ?string
    {
        $body = Canonicalizer::significant($if->stmts);
        if ($if->elseifs !== [] || $if->else !== null || count($body) !== 1) {
            return null;
        }

        $only = $body[0];
        return match (true) {
            $only instanceof Stmt\Return_ => 'return',
            $only instanceof Stmt\Expression && $only->expr instanceof Expr\Throw_ => 'throw',
            $only instanceof Stmt\Expression && $only->expr instanceof Expr\Exit_ => 'exit',
            default => null,
        };
    }

    /**
     * 含 closure / arrow function 的參數不輸出 fallback fact（內容會是整段 callback body）。
     */
    private static function containsCallback(Node $node): bool
    {
        return (new NodeFinder())->findFirst(
            $node,
            static fn (Node $child): bool => $child instanceof Expr\Closure || $child instanceof Expr\ArrowFunction,
        ) !== null;
    }

    private function childContainer(Node $node, string $name, string $container): string
    {
        return match (true) {
            $node instanceof Node\PropertyItem && $name === 'default' => 'property:$' . $node->name->toString(),
            $node instanceof Node\Const_ && $name === 'value' => 'const:' . $node->name->toString(),
            $node instanceof Expr\Assign && $name === 'expr' && $node->var instanceof Expr\Variable && is_string($node->var->name)
                => 'assign:$' . $node->var->name,
            $node instanceof Node\ArrayItem && $name === 'value' && $node->key instanceof Scalar\String_
                => $container . '[' . $node->key->value . ']',
            $node instanceof Stmt\Return_ => 'return',
            ($node instanceof Stmt\If_ || $node instanceof Stmt\ElseIf_) && $name === 'cond' => 'if',
            ($node instanceof Stmt\While_ || $node instanceof Stmt\Do_) && $name === 'cond' => 'while',
            $node instanceof Stmt\For_ && $name === 'cond' => 'for',
            $node instanceof Expr\Ternary && $name === 'cond' => 'ternary',
            $node instanceof Expr\Match_ && $name === 'cond' => 'match',
            $node instanceof Node\MatchArm && $name === 'conds' => 'match-arm',
            $node instanceof Node\Param && $name === 'var' => 'param',
            $node instanceof Node\ClosureUse && $name === 'var' => 'closure-use',
            $node instanceof Stmt\Global_ => 'global',
            $node instanceof Node\StaticVar && $name === 'var' => 'static',
            default => $container,
        };
    }

    private function argumentContainer(?array $call, string $argument): string
    {
        return ($call['callee'] ?? 'call') . $argument;
    }

    private function isCall(mixed $node): bool
    {
        return $node instanceof Expr\MethodCall
            || $node instanceof Expr\NullsafeMethodCall
            || $node instanceof Expr\StaticCall;
    }

    private function receiverOf(Node $call): ?Node
    {
        return match (true) {
            $call instanceof Expr\MethodCall, $call instanceof Expr\NullsafeMethodCall => $call->var,
            default => null,
        };
    }

    private function text(Node $node, string $source): string
    {
        $start = $node->getStartFilePos();
        return trim(substr($source, $start, $node->getEndFilePos() + 1 - $start));
    }

    /**
     * @param array<string, mixed> $properties
     */
    private function addFact(string $kind, Node $node, string $source, array $properties, ?string $subject = null): void
    {
        $startByte = $node->getStartFilePos();
        $endByte = $node->getEndFilePos() + 1;
        $subject ??= $this->subject();
        $detail = json_encode($properties, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        $this->facts[] = [
            'id' => 'php-' . substr(hash('sha256', implode('|', [$kind, $this->path, $subject, $detail, $startByte, $endByte])), 0, 20),
            'kind' => $kind,
            'subject' => $subject,
            'properties' => $properties,
            'provenance' => [
                'path' => $this->path,
                'startByte' => $startByte,
                'endByte' => $endByte,
            ],
        ];
    }

    /**
     * Longest common subsequence，回傳配對 index 序列。
     *
     * @param list<string> $left
     * @param list<string> $right
     * @return list<array{int, int}>
     */
    private static function lcs(array $left, array $right): array
    {
        $rows = count($left);
        $cols = count($right);
        // 前後相同的部分先剝除，避免大型 statement list 的 O(n*m) 表格。
        $prefix = 0;
        while ($prefix < $rows && $prefix < $cols && $left[$prefix] === $right[$prefix]) {
            $prefix += 1;
        }
        $suffix = 0;
        while (
            $suffix < $rows - $prefix
            && $suffix < $cols - $prefix
            && $left[$rows - 1 - $suffix] === $right[$cols - 1 - $suffix]
        ) {
            $suffix += 1;
        }

        $pairs = [];
        for ($index = 0; $index < $prefix; $index += 1) {
            $pairs[] = [$index, $index];
        }

        $middleLeft = array_slice($left, $prefix, $rows - $prefix - $suffix);
        $middleRight = array_slice($right, $prefix, $cols - $prefix - $suffix);
        $m = count($middleLeft);
        $n = count($middleRight);
        $table = array_fill(0, $m + 1, array_fill(0, $n + 1, 0));
        for ($i = $m - 1; $i >= 0; $i -= 1) {
            for ($j = $n - 1; $j >= 0; $j -= 1) {
                $table[$i][$j] = $middleLeft[$i] === $middleRight[$j]
                    ? $table[$i + 1][$j + 1] + 1
                    : max($table[$i + 1][$j], $table[$i][$j + 1]);
            }
        }
        $i = 0;
        $j = 0;
        while ($i < $m && $j < $n) {
            if ($middleLeft[$i] === $middleRight[$j]) {
                $pairs[] = [$prefix + $i, $prefix + $j];
                $i += 1;
                $j += 1;
            } elseif ($table[$i + 1][$j] >= $table[$i][$j + 1]) {
                $i += 1;
            } else {
                $j += 1;
            }
        }

        for ($index = 0; $index < $suffix; $index += 1) {
            $pairs[] = [$rows - $suffix + $index, $cols - $suffix + $index];
        }

        return $pairs;
    }
}
