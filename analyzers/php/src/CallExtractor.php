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
 */
final class CallExtractor
{
    private const IGNORED_TOKENS = [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG, T_CLOSE_TAG];

    /** @var list<array<string, mixed>> */
    private array $calls = [];

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
     * @return list<array<string, mixed>> calls（依 startByte 排序）。
     */
    public static function extract(
        array $statements,
        array $tokens,
        string $source,
        string $path,
        Canonicalizer $hasher,
    ): array {
        $extractor = new self($source, $path, $tokens, $hasher);
        $extractor->walkList($statements, null, null);

        $calls = $extractor->calls;
        usort($calls, static fn (array $left, array $right): int => $left['startByte'] <=> $right['startByte']);

        return $calls;
    }

    /**
     * @param array<mixed> $nodes
     */
    private function walkList(array $nodes, ?string $class, ?string $function): void
    {
        foreach ($nodes as $node) {
            if ($node instanceof Node) {
                $this->walk($node, $class, $function);
            } elseif (is_array($node)) {
                $this->walkList($node, $class, $function);
            }
        }
    }

    private function walk(Node $node, ?string $class, ?string $function): void
    {
        if ($node instanceof Stmt\ClassLike) {
            // 匿名 class 沒有名稱；method subject 只保留 method name。
            $class = $node->name?->toString();
            $function = null;
        } elseif ($node instanceof Stmt\ClassMethod || $node instanceof Stmt\Function_) {
            $function = $node->name->toString();
        }

        if (
            ($node instanceof Expr\MethodCall
                || $node instanceof Expr\NullsafeMethodCall
                || $node instanceof Expr\StaticCall)
            && $node->name instanceof Identifier
        ) {
            $this->describeCall($node, $class, $function);
        }

        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($child instanceof Node) {
                $this->walk($child, $class, $function);
            } elseif (is_array($child)) {
                $this->walkList($child, $class, $function);
            }
        }
    }

    /**
     * 記錄一筆 call；不支援的 receiver（`static::`、`$a['k']->m()` 等）不記錄。
     */
    private function describeCall(
        Expr\MethodCall|Expr\NullsafeMethodCall|Expr\StaticCall $node,
        ?string $class,
        ?string $function,
    ): void {
        $methodName = $node->name->toString();
        $isStatic = $node instanceof Expr\StaticCall;
        $operator = $isStatic ? '::' : ($node instanceof Expr\NullsafeMethodCall ? '?->' : '->');
        $receiver = $isStatic ? $node->class : $node->var;

        // 以 method name 前的 operator token 與其左側 token 判斷 receiver 形狀（與舊 token extractor 相同）：
        // `)->method(` 視為鏈式 call（含 `(new Foo)->x()`、`(expr)->x()`），其餘必須是名稱鏈。
        $operatorPosition = $this->previousSignificantPosition($node->name->getStartTokenPos());
        $leftPosition = $operatorPosition === null ? null : $this->previousSignificantPosition($operatorPosition);
        if ($leftPosition === null) {
            return;
        }

        if ($this->tokens[$leftPosition]->text === ')') {
            if ($isStatic) {
                return;
            }
            $startPosition = $operatorPosition;
            $callee = $operator . $methodName;
        } else {
            $described = $this->receiverText($receiver);
            if ($described === null || $receiver->getEndTokenPos() !== $leftPosition) {
                return;
            }
            [$receiverText, $startPosition] = $described;
            $callee = $receiverText . $operator . $methodName;
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

        $this->calls[] = [
            'nodeId' => spl_object_id($node),
            'hasCallbackBody' => $hasCallbackBody,
            'callee' => $callee,
            'subject' => $this->subject($class, $function),
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
     * @return array{0: string, 1: int}|null
     */
    private function receiverText(Node $receiver): ?array
    {
        if ($receiver instanceof Expr\Variable) {
            return is_string($receiver->name)
                ? ['$' . $receiver->name, $receiver->getStartTokenPos()]
                : null;
        }
        if (
            ($receiver instanceof Expr\PropertyFetch || $receiver instanceof Expr\NullsafePropertyFetch)
            && $receiver->name instanceof Identifier
        ) {
            $name = $receiver->name->toString();
            $base = $this->receiverText($receiver->var);
            if ($base === null) {
                return [$name, $receiver->name->getStartTokenPos()];
            }
            $operator = $receiver instanceof Expr\NullsafePropertyFetch ? '?->' : '->';
            return [$base[0] . $operator . $name, $base[1]];
        }
        if ($receiver instanceof Expr\StaticPropertyFetch && $receiver->name instanceof Node\VarLikeIdentifier) {
            return ['$' . $receiver->name->toString(), $receiver->name->getStartTokenPos()];
        }
        if (
            $receiver instanceof Expr\ClassConstFetch
            && $receiver->name instanceof Identifier
            && strtolower($receiver->name->toString()) !== 'class'
        ) {
            return [$receiver->name->toString(), $receiver->name->getStartTokenPos()];
        }
        if ($receiver instanceof Name) {
            $position = $receiver->getStartTokenPos();
            $token = $this->tokens[$position];
            $nameTokens = [T_STRING, T_NAME_QUALIFIED, T_NAME_FULLY_QUALIFIED, T_NAME_RELATIVE];
            return in_array($token->id, $nameTokens, true) ? [$token->text, $position] : null;
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
