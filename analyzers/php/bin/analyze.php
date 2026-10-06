<?php

declare(strict_types=1);

function respond(array $payload, int $exitCode = 0): never
{
    echo json_encode(
        $payload,
        JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR,
    );
    exit($exitCode);
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

function tokenIsName(array $token): bool
{
    if ($token['id'] === T_VARIABLE || $token['id'] === T_STRING) {
        return true;
    }

    $qualifiedIds = [];
    foreach (['T_NAME_QUALIFIED', 'T_NAME_FULLY_QUALIFIED', 'T_NAME_RELATIVE'] as $name) {
        if (defined($name)) {
            $qualifiedIds[] = constant($name);
        }
    }

    return $token['id'] !== null && in_array($token['id'], $qualifiedIds, true);
}

function subjectAtOffset(array $tokens, int $targetOffset, string $path): string
{
    $depth = 0;
    $pendingClass = null;
    $pendingFunction = null;
    $awaitingClassName = false;
    $awaitingFunctionName = false;
    $classScopes = [];
    $functionScopes = [];

    foreach ($tokens as $token) {
        if ($token['start'] >= $targetOffset) {
            break;
        }

        if ($token['id'] === T_CLASS) {
            $awaitingClassName = true;
        } elseif ($awaitingClassName && $token['id'] === T_STRING) {
            $pendingClass = $token['text'];
            $awaitingClassName = false;
        }

        if ($token['id'] === T_FUNCTION) {
            $awaitingFunctionName = true;
        } elseif ($awaitingFunctionName && $token['id'] === T_STRING) {
            $pendingFunction = $token['text'];
            $awaitingFunctionName = false;
        } elseif ($awaitingFunctionName && $token['text'] === '(') {
            $awaitingFunctionName = false;
        }

        if ($token['text'] === '{') {
            $depth += 1;
            if ($pendingClass !== null) {
                $classScopes[] = ['name' => $pendingClass, 'depth' => $depth];
                $pendingClass = null;
            }
            if ($pendingFunction !== null) {
                $functionScopes[] = ['name' => $pendingFunction, 'depth' => $depth];
                $pendingFunction = null;
            }
            continue;
        }

        if ($token['text'] === '}') {
            while ($functionScopes !== [] && end($functionScopes)['depth'] === $depth) {
                array_pop($functionScopes);
            }
            while ($classScopes !== [] && end($classScopes)['depth'] === $depth) {
                array_pop($classScopes);
            }
            $depth = max(0, $depth - 1);
        }
    }

    $function = $functionScopes !== [] ? end($functionScopes)['name'] : null;
    $class = $classScopes !== [] ? end($classScopes)['name'] : null;

    if ($class !== null && $function !== null) {
        return $class . '::' . $function;
    }
    if ($function !== null) {
        return $function;
    }

    return $path;
}

function findClosingParen(array $tokens, int $openIndex): ?int
{
    $depth = 0;
    for ($index = $openIndex; $index < count($tokens); $index += 1) {
        if ($tokens[$index]['text'] === '(') {
            $depth += 1;
        } elseif ($tokens[$index]['text'] === ')') {
            $depth -= 1;
            if ($depth === 0) {
                return $index;
            }
        }
    }

    return null;
}

function splitArgumentSegments(array $tokens, int $openIndex, int $closeIndex): array
{
    $segments = [];
    $segmentStart = $openIndex + 1;
    $parenDepth = 0;
    $bracketDepth = 0;
    $braceDepth = 0;

    for ($index = $openIndex + 1; $index < $closeIndex; $index += 1) {
        $text = $tokens[$index]['text'];

        if ($text === '(') {
            $parenDepth += 1;
        } elseif ($text === ')') {
            $parenDepth -= 1;
        } elseif ($text === '[') {
            $bracketDepth += 1;
        } elseif ($text === ']') {
            $bracketDepth -= 1;
        } elseif ($text === '{') {
            $braceDepth += 1;
        } elseif ($text === '}') {
            $braceDepth -= 1;
        }

        if (
            $text === ','
            && $parenDepth === 0
            && $bracketDepth === 0
            && $braceDepth === 0
        ) {
            if ($segmentStart <= $index - 1) {
                $segments[] = [$segmentStart, $index - 1];
            }
            $segmentStart = $index + 1;
        }
    }

    if ($segmentStart <= $closeIndex - 1) {
        $segments[] = [$segmentStart, $closeIndex - 1];
    }

    return $segments;
}

function namedArguments(array $tokens, int $openIndex, int $closeIndex, string $source): array
{
    $arguments = [];

    foreach (splitArgumentSegments($tokens, $openIndex, $closeIndex) as [$start, $end]) {
        if (
            $end - $start < 2
            || $tokens[$start]['id'] !== T_STRING
            || $tokens[$start + 1]['text'] !== ':'
        ) {
            continue;
        }

        $expressionStart = $start + 2;
        $expressionEnd = $end;
        $byteStart = $tokens[$expressionStart]['start'];
        $byteEnd = $tokens[$expressionEnd]['end'];

        $arguments[$tokens[$start]['text']] = [
            'expression' => trim(substr($source, $byteStart, $byteEnd - $byteStart)),
            'startByte' => $byteStart,
            'endByte' => $byteEnd,
        ];
    }

    return $arguments;
}

function extractCalls(string $source, string $path): array
{
    $tokens = significantTokens($source);
    $calls = [];

    for ($index = 0; $index + 3 < count($tokens); $index += 1) {
        $left = $tokens[$index];
        $operator = $tokens[$index + 1];
        $method = $tokens[$index + 2];
        $open = $tokens[$index + 3];

        if (
            !tokenIsName($left)
            || !in_array($operator['id'], [T_OBJECT_OPERATOR, T_DOUBLE_COLON], true)
            || $method['id'] !== T_STRING
            || $open['text'] !== '('
        ) {
            continue;
        }

        $closeIndex = findClosingParen($tokens, $index + 3);
        if ($closeIndex === null) {
            continue;
        }

        $callee = $left['text'] . $operator['text'] . $method['text'];
        $callEnd = $tokens[$closeIndex]['end'];
        $statementEnd = $callEnd;
        if (($tokens[$closeIndex + 1]['text'] ?? null) === ';') {
            $statementEnd = $tokens[$closeIndex + 1]['end'];
        }

        $calls[] = [
            'callee' => $callee,
            'subject' => subjectAtOffset($tokens, $left['start'], $path),
            'startByte' => $left['start'],
            'endByte' => $callEnd,
            'statementEndByte' => $statementEnd,
            'namedArguments' => namedArguments($tokens, $index + 3, $closeIndex, $source),
        ];

        $index = $closeIndex;
    }

    return $calls;
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

function isTransactionCall(array $call): bool
{
    return str_ends_with($call['callee'], 'DB::transaction');
}

function isAuthorizationCall(array $call): bool
{
    return str_ends_with($call['callee'], '->authorize')
        || str_ends_with($call['callee'], 'Gate::authorize');
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
    $beforeCalls = extractCalls($beforeSource, $path);
    $afterCalls = extractCalls($afterSource, $path);
    normalizedSignature($beforeSource);
    normalizedSignature($afterSource);
} catch (ParseError) {
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

        foreach ($beforeCall['namedArguments'] as $argument => $beforeArgument) {
            $afterArgument = $afterCall['namedArguments'][$argument] ?? null;
            if (
                $afterArgument === null
                || $beforeArgument['expression'] === $afterArgument['expression']
            ) {
                continue;
            }

            $facts[] = [
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
}

$beforeTransactionCalls = array_values(array_filter($beforeCalls, 'isTransactionCall'));
$afterTransactionCalls = array_values(array_filter($afterCalls, 'isTransactionCall'));
for (
    $index = count($afterTransactionCalls);
    $index < count($beforeTransactionCalls);
    $index += 1
) {
    $call = $beforeTransactionCalls[$index];
    $facts[] = [
        'id' => makeFactId(
            'TRANSACTION_BOUNDARY_REMOVED',
            $path,
            $call['subject'],
            $call['callee'],
            $call['startByte'],
            $call['statementEndByte'],
        ),
        'kind' => 'TRANSACTION_BOUNDARY_REMOVED',
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
}

$beforeAuthorizationCalls = array_values(array_filter($beforeCalls, 'isAuthorizationCall'));
$afterAuthorizationCalls = array_values(array_filter($afterCalls, 'isAuthorizationCall'));
for (
    $index = count($afterAuthorizationCalls);
    $index < count($beforeAuthorizationCalls);
    $index += 1
) {
    $call = $beforeAuthorizationCalls[$index];
    $facts[] = [
        'id' => makeFactId(
            'AUTHORIZATION_GUARD_REMOVED',
            $path,
            $call['subject'],
            $call['callee'],
            $call['startByte'],
            $call['statementEndByte'],
        ),
        'kind' => 'AUTHORIZATION_GUARD_REMOVED',
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
    $maskBefore[] = [$call['startByte'], $call['statementEndByte'], ''];
}

$complete = normalizedSignature(maskRanges($beforeSource, $maskBefore))
    === normalizedSignature(maskRanges($afterSource, $maskAfter));

respond([
    'ok' => true,
    'status' => $complete ? 'COMPLETE' : 'PARTIAL_PARSE',
    'complete' => $complete,
    'reasonCode' => $complete ? null : 'UNRECOGNIZED_PHP_CHANGE',
    'diagnostics' => $complete ? [] : ['UNRECOGNIZED_PHP_CHANGE'],
    'facts' => sortedFacts($facts),
    'phpVersion' => PHP_VERSION,
]);
