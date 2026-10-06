<?php

declare(strict_types=1);

use PhpParser\Error as PhpParserError;
use PhpParser\ParserFactory;
use PhpParser\PhpVersion;
use Reviewer\PhpAnalyzer\CallExtractor;
use Reviewer\PhpAnalyzer\CallFacts;
use Reviewer\PhpAnalyzer\Canonicalizer;
use Reviewer\PhpAnalyzer\StructuralDiff;

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
 * 先以最新 PHP 語法解析；任一側失敗時，兩側一起改用 PHP 7.4 語法重試
 * （支援 `$str{0}` 等 PHP 8 已移除的語法），確保 before / after 使用同一套語法。
 *
 * @return list<array{0: list<\PhpParser\Node\Stmt>, 1: list<\PhpParser\Token>}>
 */
function parsePair(string $beforeSource, string $afterSource): array
{
    $factory = new ParserFactory();
    $grammars = [
        static fn () => $factory->createForNewestSupportedVersion(),
        static fn () => $factory->createForVersion(PhpVersion::fromString('7.4')),
    ];

    foreach ($grammars as $index => $createParser) {
        try {
            $parsed = [];
            foreach ([$beforeSource, $afterSource] as $source) {
                $parser = $createParser();
                $parsed[] = [$parser->parse($source) ?? [], $parser->getTokens()];
            }
            return $parsed;
        } catch (PhpParserError $error) {
            if ($index === count($grammars) - 1) {
                throw $error;
            }
        }
    }

    throw new LogicException('unreachable');
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

try {
    [[$beforeAst, $beforeTokens], [$afterAst, $afterTokens]] = parsePair($beforeSource, $afterSource);
} catch (PhpParserError) {
    respond([
        'ok' => false,
        'code' => 'PHP_PARSE_ERROR',
        'phpVersion' => PHP_VERSION,
    ]);
}

$beforeHasher = new Canonicalizer();
$afterHasher = new Canonicalizer();
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

$complete = $diff['unexplained'] === [];

respond([
    'ok' => true,
    'status' => $complete ? 'COMPLETE' : 'PARTIAL_PARSE',
    'complete' => $complete,
    'reasonCode' => $complete ? null : 'UNRECOGNIZED_PHP_CHANGE',
    'diagnostics' => $complete ? [] : ['UNRECOGNIZED_PHP_CHANGE'],
    'facts' => sortedFacts([...$callFacts, ...$diff['facts']]),
    'phpVersion' => PHP_VERSION,
]);
