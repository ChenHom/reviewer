<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

use PhpParser\Node;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Identifier;
use PhpParser\Node\Name;
use PhpParser\Node\Stmt;
use PhpParser\Token;

/**
 * 以 PHP-Parser AST 抽取 method / static call。
 *
 * callee 命名、subject 與 byte ranges 沿用舊 token-based extractor 的規則，
 * 讓既有 fact 與 interpreter 不受 parser 替換影響。每筆 call 帶 `nodeId`，
 * 供 StructuralDiff 把 AST 差異對應回 call facts。
 *
 * 每筆 call 帶所在的 closure / arrow function 錨點鏈（`chain`，與 TS analyzer 的 `extractCalls()` 相同），
 * CallFacts::assignSlots() 以此把同一個 subject 內的 call 再依 closure 分組：call 從一個 closure 移到另一個
 * （例如 `$this->verifySign()` 從 `/admin` 路由的 closure 移到另一條路由）時兩邊的計數不同，產生
 * CALL_REMOVED / CALL_ADDED。錨點相同的 closure 依出現順序編號；前面新增錨點不同的 closure（例如另一條路由）
 * 不影響編號。具名 method / function 與 class 重新開始。
 */
final class CallExtractor
{
    private const IGNORED_TOKENS = [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG, T_CLOSE_TAG];

    /** @var list<array<string, mixed>> */
    private array $calls = [];

    /** @var array<int, string> spl_object_id(作為參數的 closure / arrow function) → 錨點 */
    private array $anchors = [];

    /** @var array<string, int> subject + 錨點鏈 + 錨點 → 已出現次數 */
    private array $occurrences = [];

    /** @var array<string, true> 檔案中每個 closure / arrow function 的位置（見 closureKey()） */
    private array $closures = [];

    /** @var array<int, int> token position → significant token index */
    private array $significantIndex = [];

    /** @var list<int> significant token index → token position */
    private array $significantPositions = [];

    /**
     * @param list<Token> $tokens PHP-Parser token stream（含 whitespace / comments）。
     */
    private function __construct(
        private readonly string $source,
        private readonly string $path,
        private readonly array $tokens,
        private readonly Canonicalizer $hasher,
    ) {
        foreach ($tokens as $position => $token) {
            if (!in_array($token->id, self::IGNORED_TOKENS, true)) {
                $this->significantIndex[$position] = count($this->significantPositions);
                $this->significantPositions[] = $position;
            }
        }
    }

    /**
     * @param list<Stmt> $statements parsed AST。
     * @param list<Token> $tokens parser token stream。
     * @return array{calls: list<array<string, mixed>>, closures: array<string, true>} calls（依 startByte 排序）
     *         與每個 closure / arrow function 的位置（供 CallFacts::assignSlots() 使用）。
     */
    public static function extract(
        array $statements,
        array $tokens,
        string $source,
        string $path,
        Canonicalizer $hasher,
    ): array {
        $extractor = new self($source, $path, $tokens, $hasher);
        $extractor->walkList($statements, null, null, [], null);

        $calls = $extractor->calls;
        usort($calls, static fn (array $left, array $right): int => $left['startByte'] <=> $right['startByte']);

        return ['calls' => $calls, 'closures' => $extractor->closures];
    }

    /**
     * closure 位置的 key：subject 加上從外到內的錨點鏈（每段為 `錨點#第幾個`）。錨點只含名稱、hash 與
     * node 種類，不會出現分隔字元。
     *
     * @param list<string> $chain
     */
    public static function closureKey(string $subject, array $chain): string
    {
        return $subject . "\x1f" . implode("\x1e", $chain);
    }

    /**
     * @param array<mixed> $nodes
     * @param list<string> $chain 所在的 closure 錨點鏈（不在 closure 內時為空）。
     */
    private function walkList(array $nodes, ?string $class, ?string $function, array $chain, ?Node $parent): void
    {
        foreach ($nodes as $node) {
            if ($node instanceof Node) {
                $this->walk($node, $class, $function, $chain, $parent);
            } elseif (is_array($node)) {
                $this->walkList($node, $class, $function, $chain, $parent);
            }
        }
    }

    /**
     * @param list<string> $chain 所在的 closure 錨點鏈。
     */
    private function walk(Node $node, ?string $class, ?string $function, array $chain, ?Node $parent): void
    {
        if ($node instanceof Stmt\ClassLike) {
            // 匿名 class 沒有名稱；method subject 只保留 method name。
            $class = $node->name?->toString();
            $function = null;
            $chain = [];
        } elseif ($node instanceof Stmt\ClassMethod || $node instanceof Stmt\Function_) {
            $function = $node->name->toString();
            $chain = [];
        } elseif ($node instanceof Expr\Closure || $node instanceof Expr\ArrowFunction) {
            // 不是呼叫參數的 closure（指派、return、陣列元素等）以所在位置的 node 種類為錨點。
            $anchor = $this->anchors[spl_object_id($node)] ?? $parent?->getType() ?? 'root';
            $subject = $this->subject($class, $function);
            $counter = self::closureKey($subject, $chain) . "\x1f" . $anchor;
            $occurrence = $this->occurrences[$counter] ?? 0;
            $this->occurrences[$counter] = $occurrence + 1;
            $chain[] = $anchor . '#' . $occurrence;
            $this->closures[self::closureKey($subject, $chain)] = true;
        }

        $calleeKey = null;
        if (
            ($node instanceof Expr\MethodCall
                || $node instanceof Expr\NullsafeMethodCall
                || $node instanceof Expr\StaticCall)
            && $node->name instanceof Identifier
        ) {
            $call = $this->describeCall($node, $class, $function, $chain);
            if ($call !== null) {
                $this->calls[] = $call;
                $calleeKey = $call['calleeKey'];
            }
        }
        if ($node instanceof Expr\CallLike) {
            $this->anchorCallbacks($node, $calleeKey);
        }

        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($child instanceof Node) {
                $this->walk($child, $class, $function, $chain, $node);
            } elseif (is_array($child)) {
                $this->walkList($child, $class, $function, $chain, $node);
            }
        }
    }

    /**
     * 直接作為參數的 closure / arrow function 的錨點：傳給哪個呼叫的第幾個參數（具名參數為名稱），以及該呼叫
     * 的常數參數（`Route::post('/admin', function () { … })` → `Route::post(<'/admin' 的 hash>,_)#1`）。
     *
     * 常數參數只取字面值、常數與 class 常數（路由路徑、測試名稱、`Foo::class`），以 canonical hash 表示，
     * 引號種類等排版不影響錨點。與 TS analyzer 不同，陣列一律視為 `_`：`Route::group([...], function () { … })`
     * 的陣列是 middleware / prefix 等設定，只改設定時群組內的 call 不應被當成移除 + 新增。
     *
     * @param string|null $calleeKey 呼叫的 call record key；沒有 call record 時為 null。
     */
    private function anchorCallbacks(Expr\CallLike $call, ?string $calleeKey): void
    {
        $callbacks = [];
        foreach ($call->args as $index => $arg) {
            if ($arg instanceof Arg && ($arg->value instanceof Expr\Closure || $arg->value instanceof Expr\ArrowFunction)) {
                $callbacks[spl_object_id($arg->value)] = $arg->name?->toString() ?? (string) $index;
            }
        }
        if ($callbacks === []) {
            return;
        }

        $literals = [];
        foreach ($call->args as $arg) {
            $constant = $arg instanceof Arg
                && !$arg->unpack
                && !$arg->value instanceof Expr\Array_
                && StructuralDiff::isConstant($arg->value);
            $name = $arg instanceof Arg && $arg->name !== null ? $arg->name->toString() . ':' : '';
            $literals[] = $name . ($constant ? $this->hasher->hash($arg->value) : '_');
        }
        $callee = $calleeKey ?? self::anchorCallee($call);
        foreach ($callbacks as $id => $position) {
            $this->anchors[$id] = $callee . '(' . implode(',', $literals) . ')#' . $position;
        }
    }

    /**
     * 沒有 call record 的呼叫（function call、`new`、`static::` 等不支援的 receiver）：以 node 種類與名稱表示。
     */
    private static function anchorCallee(Expr\CallLike $call): string
    {
        $names = match (true) {
            $call instanceof Expr\FuncCall => [$call->name],
            $call instanceof Expr\New_ => [$call->class],
            $call instanceof Expr\StaticCall => [$call->class, $call->name],
            default => [$call->name],
        };

        return implode(':', [
            $call->getType(),
            ...array_map(
                static fn (mixed $name): string => $name instanceof Name || $name instanceof Identifier ? $name->toString() : '?',
                $names,
            ),
        ]);
    }

    /**
     * 描述一筆 call；不支援的 receiver（`static::`、`$a['k']->m()` 等）回傳 null。
     *
     * @param list<string> $chain 所在的 closure 錨點鏈。
     * @return array<string, mixed>|null call record。
     */
    private function describeCall(
        Expr\MethodCall|Expr\NullsafeMethodCall|Expr\StaticCall $node,
        ?string $class,
        ?string $function,
        array $chain,
    ): ?array {
        $methodName = $node->name->toString();
        $isStatic = $node instanceof Expr\StaticCall;
        $operator = $isStatic ? '::' : ($node instanceof Expr\NullsafeMethodCall ? '?->' : '->');
        $receiver = $isStatic ? $node->class : $node->var;

        // 以 method name 前的 operator token 與其左側 token 判斷 receiver 形狀（與舊 token extractor 相同）：
        // `)->method(` 視為鏈式 call（含 `(new Foo)->x()`、`(expr)->x()`），其餘必須是名稱鏈。
        $operatorPosition = $this->previousSignificantPosition($node->name->getStartTokenPos());
        $leftPosition = $operatorPosition === null ? null : $this->previousSignificantPosition($operatorPosition);
        if ($leftPosition === null) {
            return null;
        }

        if ($this->tokens[$leftPosition]->text === ')') {
            if ($isStatic) {
                return null;
            }
            $startPosition = $operatorPosition;
            $callee = $operator . $methodName;
            $calleeKey = $callee;
            $segments = null;
        } else {
            $described = $this->receiverText($receiver);
            if ($described === null || $receiver->getEndTokenPos() !== $leftPosition) {
                return null;
            }
            [$receiverText, $startPosition, $receiverKey, $segments] = $described;
            $callee = $receiverText . $operator . $methodName;
            $calleeKey = $receiverKey . $operator . $methodName;
        }

        $openPosition = $this->nextSignificantPosition($node->name->getEndTokenPos());
        $closePosition = $node->getEndTokenPos();
        $callEnd = $node->getEndFilePos() + 1;
        $statementEnd = $callEnd;
        $afterClose = $this->nextSignificantPosition($closePosition);
        if ($afterClose !== null && $this->tokens[$afterClose]->text === ';') {
            $statementEnd = $this->tokenEnd($afterClose);
        }

        $hasCallbackBody = $this->rangeContainsCallback($openPosition + 1, $closePosition - 1);

        return [
            'nodeId' => spl_object_id($node),
            'hasCallbackBody' => $hasCallbackBody,
            'callee' => self::callee($callee, $methodName, $segments, $isStatic ? 'static' : 'method', $operator === '?->'),
            // 配對用 key：receiver 中可改名的區域變數換成 canonical 名稱。
            'calleeKey' => $calleeKey,
            'subject' => $this->subject($class, $function),
            // 所在的 closure 錨點鏈；配對用的 `slot` 由 CallFacts::assignSlots() 依兩側都存在的 closure 決定。
            'chain' => $chain,
            'startByte' => $this->tokens[$startPosition]->pos,
            'endByte' => $callEnd,
            'statementEndByte' => $statementEnd,
            'namedArguments' => $this->namedArguments($node->args),
        ];
    }

    /**
     * 回傳 receiver 的「名稱鏈」文字與起始 token。
     *
     * 與舊 token extractor 相容：只沿 `->` / `?->` 回溯連續的名稱 token，
     * 遇到非名稱（如 `foo()->bar`）時只保留最長的名稱後綴（`bar`）。
     *
     * @return array{0: string, 1: int, 2: string, 3: list<string>}|null [文字, 起始 token, canonical key, receiver 路徑]
     */
    private function receiverText(Node $receiver): ?array
    {
        if ($receiver instanceof Expr\Variable) {
            return is_string($receiver->name)
                ? ['$' . $receiver->name, $receiver->getStartTokenPos(), '$' . $this->hasher->variableName($receiver), [$receiver->name]]
                : null;
        }
        if (
            ($receiver instanceof Expr\PropertyFetch || $receiver instanceof Expr\NullsafePropertyFetch)
            && $receiver->name instanceof Identifier
        ) {
            $name = $receiver->name->toString();
            $base = $this->receiverText($receiver->var);
            if ($base === null) {
                return [$name, $receiver->name->getStartTokenPos(), $name, [$name]];
            }
            $operator = $receiver instanceof Expr\NullsafePropertyFetch ? '?->' : '->';
            return [$base[0] . $operator . $name, $base[1], $base[2] . $operator . $name, [...$base[3], $name]];
        }
        if ($receiver instanceof Expr\StaticPropertyFetch && $receiver->name instanceof Node\VarLikeIdentifier) {
            $text = '$' . $receiver->name->toString();
            return [$text, $receiver->name->getStartTokenPos(), $text, [$receiver->name->toString()]];
        }
        if (
            $receiver instanceof Expr\ClassConstFetch
            && $receiver->name instanceof Identifier
            && strtolower($receiver->name->toString()) !== 'class'
        ) {
            $text = $receiver->name->toString();
            return [$text, $receiver->name->getStartTokenPos(), $text, [$text]];
        }
        if ($receiver instanceof Name) {
            $position = $receiver->getStartTokenPos();
            $token = $this->tokens[$position];
            $nameTokens = [T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_NAME_RELATIVE];
            return in_array($token->id, $nameTokens, true)
                ? [$token->text, $position, $token->text, self::nameSegments($token->text)]
                : null;
        }

        return null;
    }

    /**
     * @param array<Arg|Node\VariadicPlaceholder> $args
     * @return array<string, array<string, mixed>> named argument → expression / canonical signature / byte range
     */
    private function namedArguments(array $args): array
    {
        $named = [];
        foreach ($args as $arg) {
            if (!$arg instanceof Arg || $arg->name === null) {
                continue;
            }
            $startByte = $arg->value->getStartFilePos();
            $endByte = $arg->value->getEndFilePos() + 1;
            $named[$arg->name->toString()] = [
                'expression' => trim(substr($this->source, $startByte, $endByte - $startByte)),
                'signature' => $this->hasher->hash($arg->value),
                'startByte' => $startByte,
                'endByte' => $endByte,
            ];
        }

        return $named;
    }

    /**
     * 語言中立的結構化 callee（fact schema v2）。`text` 只供顯示；規則比對 `name` 與 `receiver`。
     *
     * @param list<string>|null $receiver 去掉 `$`、`->`、`::`、`\` 的 receiver 路徑；無法化成路徑時為 null。
     * @return array{text: string, name: string, receiver: list<string>|null, kind: string, optional: bool}
     */
    public static function callee(string $text, string $name, ?array $receiver, string $kind, bool $optional = false): array
    {
        return [
            'text' => $text,
            'name' => $name,
            'receiver' => $receiver,
            'kind' => $kind,
            'optional' => $optional,
        ];
    }

    /**
     * 名稱（class / namespace）拆成路徑，移除 fully-qualified 前導 `\`。
     *
     * @return list<string>
     */
    public static function nameSegments(string $name): array
    {
        return array_values(array_filter(explode('\\', $name), static fn (string $part): bool => $part !== ''));
    }

    private function rangeContainsCallback(int $startPosition, int $endPosition): bool
    {
        $callbackIds = [T_FUNCTION, T_FN];
        for ($position = $startPosition; $position <= $endPosition; $position += 1) {
            if (in_array($this->tokens[$position]->id, $callbackIds, true)) {
                return true;
            }
        }

        return false;
    }

    private function nextSignificantPosition(int $position): ?int
    {
        for ($next = $position + 1; $next < count($this->tokens); $next += 1) {
            if (isset($this->significantIndex[$next])) {
                return $next;
            }
        }

        return null;
    }

    private function previousSignificantPosition(int $position): ?int
    {
        $index = $this->significantIndex[$position] ?? null;
        if ($index === null || $index === 0) {
            return null;
        }

        return $this->significantPositions[$index - 1];
    }

    private function tokenEnd(int $position): int
    {
        return $this->tokens[$position]->pos + strlen($this->tokens[$position]->text);
    }

    private function subject(?string $class, ?string $function): string
    {
        if ($class !== null && $function !== null) {
            return $class . '::' . $function;
        }

        return $function ?? $this->path;
    }
}
