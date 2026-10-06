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
 * 輸出格式與舊 token-based extractor 相同（callee、subject、byte ranges、
 * masking 能力、named / positional arguments），讓 fact 生成與 completeness
 * 邏輯不需改動即可替換。
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
    public static function extract(array $statements, array $tokens, string $source, string $path): array
    {
        $extractor = new self($source, $path, $tokens);
        $extractor->walkList($statements, null, null, 0);

        $calls = $extractor->calls;
        usort($calls, static fn (array $left, array $right): int => $left['startByte'] <=> $right['startByte']);

        return $calls;
    }

    /**
     * @param array<mixed> $nodes
     */
    private function walkList(array $nodes, ?string $class, ?string $function, int $argumentDepth): void
    {
        foreach ($nodes as $node) {
            if ($node instanceof Node) {
                $this->walk($node, $class, $function, $argumentDepth);
            } elseif (is_array($node)) {
                $this->walkList($node, $class, $function, $argumentDepth);
            }
        }
    }

    private function walk(Node $node, ?string $class, ?string $function, int $argumentDepth): void
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
            $receiver = $node instanceof Expr\StaticCall ? $node->class : $node->var;
            $call = $this->describeCall($node, $class, $function, $argumentDepth > 0);

            if ($receiver instanceof Node) {
                $this->walk($receiver, $class, $function, $argumentDepth);
            }
            $this->walkList($node->args, $class, $function, $call === null ? $argumentDepth : $argumentDepth + 1);
            return;
        }

        foreach ($node->getSubNodeNames() as $name) {
            $child = $node->$name;
            if ($child instanceof Node) {
                $this->walk($child, $class, $function, $argumentDepth);
            } elseif (is_array($child)) {
                $this->walkList($child, $class, $function, $argumentDepth);
            }
        }
    }

    /**
     * @return array<string, mixed>|null 加入的 call；不支援的 receiver 回傳 null。
     */
    private function describeCall(
        Expr\MethodCall|Expr\NullsafeMethodCall|Expr\StaticCall $node,
        ?string $class,
        ?string $function,
        bool $isNested,
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

        $isChained = false;
        if ($this->tokens[$leftPosition]->text === ')') {
            if ($isStatic) {
                return null;
            }
            $isChained = true;
            $startPosition = $operatorPosition;
            $callee = $operator . $methodName;
        } else {
            $described = $this->receiverText($receiver);
            if ($described === null || $receiver->getEndTokenPos() !== $leftPosition) {
                return null;
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

        $previousPosition = $this->previousSignificantPosition($startPosition);
        $isStandaloneStatement = !$isChained
            && $statementEnd > $callEnd
            && (
                $previousPosition === null
                || in_array($this->tokens[$previousPosition]->text, ['{', '}', ';', ':'], true)
            );
        $canMaskAsAtomicStatement = $isStandaloneStatement
            && !$isNested
            && !$this->rangeContainsCallback($openPosition + 1, $closePosition - 1);

        [$named, $positional] = $this->arguments($node->args);
        $startByte = $this->tokens[$startPosition]->pos;

        $call = [
            'callee' => $callee,
            'subject' => $this->subject($class, $function),
            'startByte' => $startByte,
            'endByte' => $callEnd,
            'statementEndByte' => $statementEnd,
            'isStandaloneStatement' => $isStandaloneStatement,
            'canMaskAsAtomicStatement' => $canMaskAsAtomicStatement,
            'canMaskArguments' => !$isNested && !$isChained,
            'namedArguments' => $named,
            'positionalArguments' => $positional,
        ];
        $this->calls[] = $call;

        return $call;
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
     * @return array{0: array<string, array<string, mixed>>, 1: array<int, array<string, mixed>>}
     */
    private function arguments(array $args): array
    {
        $named = [];
        $positional = [];

        foreach ($args as $index => $arg) {
            if ($arg instanceof Arg && $arg->name !== null) {
                $named[$arg->name->toString()] = $this->argument($arg->value);
            } else {
                $positional[$index] = $this->argument($arg);
            }
        }

        return [$named, $positional];
    }

    /**
     * @return array<string, mixed>
     */
    private function argument(Node $node): array
    {
        $startPosition = $node->getStartTokenPos();
        $endPosition = $node->getEndTokenPos();
        $startByte = $node->getStartFilePos();
        $endByte = $node->getEndFilePos() + 1;

        return [
            'expression' => trim(substr($this->source, $startByte, $endByte - $startByte)),
            'signature' => $this->tokenRangeSignature($startPosition, $endPosition),
            'hasCallbackBody' => $this->rangeContainsCallback($startPosition, $endPosition),
            'startByte' => $startByte,
            'endByte' => $endByte,
        ];
    }

    private function tokenRangeSignature(int $startPosition, int $endPosition): string
    {
        $parts = [];
        for ($position = $startPosition; $position <= $endPosition; $position += 1) {
            $token = $this->tokens[$position];
            if (!in_array($token->id, self::IGNORED_TOKENS, true)) {
                $parts[] = self::tokenSignatureId($token) . ':' . $token->text;
            }
        }

        return implode('|', $parts);
    }

    /**
     * 與舊 token_get_all signature 相容：單字元 token 的 id 記為 0。
     */
    public static function tokenSignatureId(Token $token): int
    {
        return $token->id < 256 ? 0 : $token->id;
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
