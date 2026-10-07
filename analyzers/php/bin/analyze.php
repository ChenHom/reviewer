<?php

declare(strict_types=1);

use PhpParser\Error as PhpParserError;
use PhpParser\Node\Stmt;
use PhpParser\NodeFinder;
use PhpParser\ParserFactory;
use PhpParser\PhpVersion;
use Reviewer\PhpAnalyzer\CallExtractor;
use Reviewer\PhpAnalyzer\CallFacts;
use Reviewer\PhpAnalyzer\Canonicalizer;
use Reviewer\PhpAnalyzer\StructuralDiff;
use Reviewer\PhpAnalyzer\VariableScopes;

function respond(array $payload, int $exitCode = 0): never
{
    echo json_encode(
        $payload,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
    );
    exit($exitCode);
}

$autoload = dirname(__DIR__) . '/vendor/autoload.php';
if (!is_file($autoload)) {
    respond([
        'ok' => false,
        'code' => 'PHP_ANALYZER_DEPENDENCY_MISSING',
        'phpVersion' => PHP_VERSION,
    ]);
}
require $autoload;

/**
 * PHP 7 對 `#[` 的解讀：`#` 開始單行註解，直到換行或 close tag。PHP-Parser 的 7.4 語法
 * 不會還原這點（AttributeEmulator::reverseEmulate 尚未實作），所以先把每個 attribute
 * 起點到行尾換成等長空白，byte 位置不變。
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
 * 以指定語法解析；失敗時回傳 null。`__halt_compiler` 節點會記錄真實的
 * `__COMPILER_HALT_OFFSET__`（終止符之後的 byte 位置）供 Canonicalizer 使用。
 *
 * @return array{0: list<\PhpParser\Node\Stmt>, 1: list<\PhpParser\Token>}|null
 */
function parseWithGrammar(string $grammar, string $source): ?array
{
    $factory = new ParserFactory();
    $parser = $grammar === 'newest'
        ? $factory->createForNewestSupportedVersion()
        : $factory->createForVersion(PhpVersion::fromString('7.4'));
    try {
        $statements = $parser->parse($grammar === 'newest' ? $source : php7View($source)) ?? [];
    } catch (PhpParserError) {
        return null;
    }
    foreach ((new NodeFinder())->findInstanceOf($statements, Stmt\HaltCompiler::class) as $halt) {
        $halt->setAttribute('haltOffset', strlen($source) - strlen($halt->remaining));
    }

    return [$statements, $parser->getTokens()];
}

/**
 * 兩棵 AST 是否等價：原始變數名稱相同，或 scope-aware canonical 名稱相同。
 *
 * @param list<\PhpParser\Node\Stmt> $before
 * @param list<\PhpParser\Node\Stmt> $after
 */
function astEquivalent(array $before, array $after): bool
{
    if ((new Canonicalizer())->hash($before) === (new Canonicalizer())->hash($after)) {
        return true;
    }

    return (new Canonicalizer(VariableScopes::canonicalNames($before)))->hash($before)
        === (new Canonicalizer(VariableScopes::canonicalNames($after)))->hash($after);
}

function sortedFacts(array $facts): array
{
    usort($facts, static function (array $left, array $right): int {
        return [
            $left['provenance']['path'],
            $left['provenance']['startByte'],
            $left['kind'],
            $left['id'],
        ] <=> [
            $right['provenance']['path'],
            $right['provenance']['startByte'],
            $right['kind'],
            $right['id'],
        ];
    });

    return $facts;
}

$input = json_decode(stream_get_contents(STDIN), true);
if (
    !is_array($input)
    || !is_string($input['path'] ?? null)
    || trim($input['path']) === ''
    || !is_string($input['beforeSource'] ?? null)
    || !is_string($input['afterSource'] ?? null)
) {
    respond([
        'ok' => false,
        'code' => 'PHP_ANALYZER_INPUT_INVALID',
        'phpVersion' => PHP_VERSION,
    ]);
}

$path = $input['path'];
$beforeSource = $input['beforeSource'];
$afterSource = $input['afterSource'];

// 主要語法：兩側都能以最新語法解析時使用最新語法，否則兩側一起改用 PHP 7.4 語法。
$grammars = ['newest', 'php74'];
$parsed = [
    'newest' => [parseWithGrammar('newest', $beforeSource), parseWithGrammar('newest', $afterSource)],
];
if (in_array(null, $parsed['newest'], true)) {
    $parsed['php74'] = [parseWithGrammar('php74', $beforeSource), parseWithGrammar('php74', $afterSource)];
    $primary = in_array(null, $parsed['php74'], true) ? null : 'php74';
} else {
    $primary = 'newest';
}
if ($primary === null) {
    respond([
        'ok' => false,
        'code' => 'PHP_PARSE_ERROR',
        'phpVersion' => PHP_VERSION,
    ]);
}
[[$beforeAst, $beforeTokens], [$afterAst, $afterTokens]] = $parsed[$primary];

/**
 * 以指定的變數命名方式分析一次：回傳 call facts、結構性 facts 與未解釋差異。
 *
 * @param array<int, string> $beforeNames
 * @param array<int, string> $afterNames
 * @return array{facts: list<array<string, mixed>>, unexplained: list<array{string, int}>}
 */
function analyzePair(
    string $path,
    string $beforeSource,
    string $afterSource,
    array $beforeAst,
    array $afterAst,
    array $beforeTokens,
    array $afterTokens,
    array $beforeNames,
    array $afterNames,
): array {
    $beforeHasher = new Canonicalizer($beforeNames);
    $afterHasher = new Canonicalizer($afterNames);
    $beforeCalls = CallExtractor::extract($beforeAst, $beforeTokens, $beforeSource, $path, $beforeHasher);
    $afterCalls = CallExtractor::extract($afterAst, $afterTokens, $afterSource, $path, $afterHasher);
    $callFacts = CallFacts::build($path, $beforeCalls, $afterCalls);

    $diff = (new StructuralDiff(
        $path,
        $beforeSource,
        $afterSource,
        array_column($beforeCalls, null, 'nodeId'),
        array_column($afterCalls, null, 'nodeId'),
        $callFacts,
        $beforeHasher,
        $afterHasher,
    ))->run($beforeAst, $afterAst);

    return ['facts' => [...$callFacts, ...$diff['facts']], 'unexplained' => $diff['unexplained']];
}

// 先以原始變數名稱比較；不完整時再以 scope-aware canonical 名稱比較（區域變數改名）。
// 兩種比較各自 sound，只有 canonical 比較能完整解釋時才採用它，其餘維持原始名稱的結果。
$analysis = analyzePair($path, $beforeSource, $afterSource, $beforeAst, $afterAst, $beforeTokens, $afterTokens, [], []);
if ($analysis['unexplained'] !== []) {
    $renamed = analyzePair(
        $path,
        $beforeSource,
        $afterSource,
        $beforeAst,
        $afterAst,
        $beforeTokens,
        $afterTokens,
        VariableScopes::canonicalNames($beforeAst),
        VariableScopes::canonicalNames($afterAst),
    );
    if ($renamed['unexplained'] === []) {
        $analysis = $renamed;
    }
}

$complete = $analysis['unexplained'] === [];
$reasonCode = $complete ? null : 'UNRECOGNIZED_PHP_CHANGE';

// 判為等價（COMPLETE 且無 fact）前，確認結論不依賴語法版本：專案可能跑在 PHP 7
// （例如 `.` 與 `+` 的優先順序在 PHP 8 改變），也可能跑在 PHP 8。兩種語法下的
// 可解析性必須一致，且兩側都能解析的語法下也必須等價；否則交給 Human Review。
if ($complete && $analysis['facts'] === []) {
    foreach ($grammars as $grammar) {
        $parsed[$grammar] ??= [parseWithGrammar($grammar, $beforeSource), parseWithGrammar($grammar, $afterSource)];
        [$before, $after] = $parsed[$grammar];
        if (($before === null) !== ($after === null) || ($before !== null && !astEquivalent($before[0], $after[0]))) {
            $complete = false;
            $reasonCode = 'PHP_GRAMMAR_DIVERGENCE';
            break;
        }
    }
}

respond([
    'ok' => true,
    'status' => $complete ? 'COMPLETE' : 'PARTIAL_PARSE',
    'complete' => $complete,
    'reasonCode' => $reasonCode,
    'diagnostics' => $complete ? [] : [$reasonCode],
    'facts' => sortedFacts(array_map(
        static function (array $fact): array {
            unset($fact['calleeKey']);
            return $fact;
        },
        $analysis['facts'],
    )),
    'phpVersion' => PHP_VERSION,
]);
