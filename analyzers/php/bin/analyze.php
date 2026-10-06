<?php

declare(strict_types=1);

use PhpParser\Error as PhpParserError;
use PhpParser\ParserFactory;
use PhpParser\PhpVersion;
use Reviewer\PhpAnalyzer\CallExtractor;

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
 * @return list<array<string, mixed>> [before calls, after calls]
 */
function extractCallPair(string $beforeSource, string $afterSource, string $path): array
{
    $factory = new ParserFactory();
    $grammars = [
        static fn () => $factory->createForNewestSupportedVersion(),
        static fn () => $factory->createForVersion(PhpVersion::fromString('7.4')),
    ];

    foreach ($grammars as $index => $createParser) {
        try {
            $calls = [];
            foreach ([$beforeSource, $afterSource] as $source) {
                $parser = $createParser();
                $statements = $parser->parse($source) ?? [];
                $calls[] = CallExtractor::extract($statements, $parser->getTokens(), $source, $path);
            }
            return $calls;
        } catch (PhpParserError $error) {
            if ($index === count($grammars) - 1) {
                throw $error;
            }
        }
    }

    throw new LogicException('unreachable');
}

function significantTokens(string $source): array
{
    $rawTokens = token_get_all($source, TOKEN_PARSE);
    $tokens = [];
    $offset = 0;
    $ignored = [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT, T_OPEN_TAG, T_CLOSE_TAG];

    foreach ($rawTokens as $rawToken) {
        if (is_array($rawToken)) {
            [$id, $text] = $rawToken;
        } else {
            $id = null;
            $text = $rawToken;
        }

        $start = $offset;
        $offset += strlen($text);

        if ($id !== null && in_array($id, $ignored, true)) {
            continue;
        }

        $tokens[] = [
            'id' => $id,
            'text' => $text,
            'start' => $start,
            'end' => $offset,
        ];
    }

    return $tokens;
}

function groupCalls(array $calls): array
{
    $groups = [];
    foreach ($calls as $call) {
        $key = $call['subject'] . '|' . $call['callee'];
        $groups[$key] ??= [];
        $groups[$key][] = $call;
    }
    return $groups;
}

function makeFactId(
    string $kind,
    string $path,
    string $subject,
    string $detail,
    int $startByte,
    int $endByte,
): string {
    return 'php-' . substr(
        hash('sha256', implode('|', [$kind, $path, $subject, $detail, $startByte, $endByte])),
        0,
        20,
    );
}

function argumentChangedFact(
    string $path,
    array $afterCall,
    string $argument,
    array $beforeArgument,
    array $afterArgument,
): array {
    return [
        'id' => makeFactId(
            'CALL_ARGUMENT_CHANGED',
            $path,
            $afterCall['subject'],
            $afterCall['callee'] . ':' . $argument,
            $afterArgument['startByte'],
            $afterArgument['endByte'],
        ),
        'kind' => 'CALL_ARGUMENT_CHANGED',
        'subject' => $afterCall['subject'],
        'properties' => [
            'callee' => $afterCall['callee'],
            'argument' => $argument,
            'before' => $beforeArgument['expression'],
            'after' => $afterArgument['expression'],
            'changeSide' => 'after',
        ],
        'provenance' => [
            'path' => $path,
            'startByte' => $afterArgument['startByte'],
            'endByte' => $afterArgument['endByte'],
        ],
    ];
}

function maskRanges(string $source, array $ranges): string
{
    usort(
        $ranges,
        static fn (array $left, array $right): int => $right[0] <=> $left[0],
    );

    foreach ($ranges as $range) {
        [$start, $end] = $range;
        $replacement = $range[2] ?? '__RDE_MASK__';
        $source = substr_replace($source, $replacement, $start, $end - $start);
    }

    return $source;
}

function normalizedSignature(string $source): string
{
    $tokens = significantTokens($source);
    $parts = array_map(
        static fn (array $token): string => ($token['id'] ?? 0) . ':' . $token['text'],
        $tokens,
    );

    return implode('|', $parts);
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
    [$beforeCalls, $afterCalls] = extractCallPair($beforeSource, $afterSource, $path);
    normalizedSignature($beforeSource);
    normalizedSignature($afterSource);
} catch (ParseError | PhpParserError) {
    respond([
        'ok' => false,
        'code' => 'PHP_PARSE_ERROR',
        'phpVersion' => PHP_VERSION,
    ]);
}

$facts = [];
$maskBefore = [];
$maskAfter = [];

$beforeGroups = groupCalls($beforeCalls);
$afterGroups = groupCalls($afterCalls);

foreach ($beforeGroups as $key => $beforeGroup) {
    $afterGroup = $afterGroups[$key] ?? [];
    $pairCount = min(count($beforeGroup), count($afterGroup));

    for ($pairIndex = 0; $pairIndex < $pairCount; $pairIndex += 1) {
        $beforeCall = $beforeGroup[$pairIndex];
        $afterCall = $afterGroup[$pairIndex];

        $canMask = $beforeCall['canMaskArguments'] && $afterCall['canMaskArguments'];

        foreach ($beforeCall['namedArguments'] as $argument => $beforeArgument) {
            $afterArgument = $afterCall['namedArguments'][$argument] ?? null;
            if (
                $afterArgument === null
                || $beforeArgument['signature'] === $afterArgument['signature']
            ) {
                continue;
            }

            $facts[] = argumentChangedFact($path, $afterCall, $argument, $beforeArgument, $afterArgument);
            if ($canMask) {
                $maskBefore[] = [
                    $beforeArgument['startByte'],
                    $beforeArgument['endByte'],
                    '__RDE_MASK__',
                ];
                $maskAfter[] = [
                    $afterArgument['startByte'],
                    $afterArgument['endByte'],
                    '__RDE_MASK__',
                ];
            }
        }

        // 位置參數變更只輸出 fact 供 interpreter 判讀，不 mask：completeness 維持 fail-closed。
        foreach ($beforeCall['positionalArguments'] as $position => $beforeArgument) {
            $afterArgument = $afterCall['positionalArguments'][$position] ?? null;
            if (
                $afterArgument === null
                || $beforeArgument['hasCallbackBody']
                || $afterArgument['hasCallbackBody']
                || $beforeArgument['signature'] === $afterArgument['signature']
            ) {
                continue;
            }

            $facts[] = argumentChangedFact($path, $afterCall, '#' . $position, $beforeArgument, $afterArgument);
        }
    }

    for ($callIndex = $pairCount; $callIndex < count($beforeGroup); $callIndex += 1) {
        $call = $beforeGroup[$callIndex];
        $facts[] = [
            'id' => makeFactId(
                'CALL_REMOVED',
                $path,
                $call['subject'],
                $call['callee'] . ':' . $callIndex,
                $call['startByte'],
                $call['statementEndByte'],
            ),
            'kind' => 'CALL_REMOVED',
            'subject' => $call['subject'],
            'properties' => [
                'callee' => $call['callee'],
                'changeSide' => 'before',
            ],
            'provenance' => [
                'path' => $path,
                'startByte' => $call['startByte'],
                'endByte' => $call['statementEndByte'],
            ],
        ];

        if ($call['canMaskAsAtomicStatement']) {
            $maskBefore[] = [$call['startByte'], $call['statementEndByte'], ''];
        }
    }

    for ($callIndex = $pairCount; $callIndex < count($afterGroup); $callIndex += 1) {
        $call = $afterGroup[$callIndex];
        $facts[] = [
            'id' => makeFactId(
                'CALL_ADDED',
                $path,
                $call['subject'],
                $call['callee'] . ':' . $callIndex,
                $call['startByte'],
                $call['statementEndByte'],
            ),
            'kind' => 'CALL_ADDED',
            'subject' => $call['subject'],
            'properties' => [
                'callee' => $call['callee'],
                'changeSide' => 'after',
            ],
            'provenance' => [
                'path' => $path,
                'startByte' => $call['startByte'],
                'endByte' => $call['statementEndByte'],
            ],
        ];

        if ($call['canMaskAsAtomicStatement']) {
            $maskAfter[] = [$call['startByte'], $call['statementEndByte'], ''];
        }
    }
}

foreach ($afterGroups as $key => $afterGroup) {
    if (array_key_exists($key, $beforeGroups)) {
        continue;
    }

    foreach ($afterGroup as $callIndex => $call) {
        $facts[] = [
            'id' => makeFactId(
                'CALL_ADDED',
                $path,
                $call['subject'],
                $call['callee'] . ':' . $callIndex,
                $call['startByte'],
                $call['statementEndByte'],
            ),
            'kind' => 'CALL_ADDED',
            'subject' => $call['subject'],
            'properties' => [
                'callee' => $call['callee'],
                'changeSide' => 'after',
            ],
            'provenance' => [
                'path' => $path,
                'startByte' => $call['startByte'],
                'endByte' => $call['statementEndByte'],
            ],
        ];

        if ($call['canMaskAsAtomicStatement']) {
            $maskAfter[] = [$call['startByte'], $call['statementEndByte'], ''];
        }
    }
}

try {
    $complete = normalizedSignature(maskRanges($beforeSource, $maskBefore))
        === normalizedSignature(maskRanges($afterSource, $maskAfter));
} catch (ParseError) {
    // mask 後的 source 無法 tokenize（例如移除 statement 破壞語法）時不能宣稱 completeness。
    $complete = false;
}

respond([
    'ok' => true,
    'status' => $complete ? 'COMPLETE' : 'PARTIAL_PARSE',
    'complete' => $complete,
    'reasonCode' => $complete ? null : 'UNRECOGNIZED_PHP_CHANGE',
    'diagnostics' => $complete ? [] : ['UNRECOGNIZED_PHP_CHANGE'],
    'facts' => sortedFacts($facts),
    'phpVersion' => PHP_VERSION,
]);
