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

function callContainsCallbackBody(array $tokens, int $openIndex, int $closeIndex): bool
{
    $callbackTokenIds = [T_FUNCTION];
    if (defined('T_FN')) {
        $callbackTokenIds[] = constant('T_FN');
    }

    for ($index = $openIndex + 1; $index < $closeIndex; $index += 1) {
        $id = $tokens[$index]['id'];
        if ($id !== null && in_array($id, $callbackTokenIds, true)) {
            return true;
        }
    }

    return false;
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

function segmentContainsCallbackBody(array $tokens, int $start, int $end): bool
{
    return callContainsCallbackBody($tokens, $start - 1, $end + 1);
}

function tokenRangeSignature(array $tokens, int $start, int $end): string
{
    $parts = [];
    for ($index = $start; $index <= $end; $index += 1) {
        $parts[] = ($tokens[$index]['id'] ?? 0) . ':' . $tokens[$index]['text'];
    }

    return implode('|', $parts);
}

function callArguments(array $tokens, int $openIndex, int $closeIndex, string $source): array
{
    $named = [];
    $positional = [];

    foreach (splitArgumentSegments($tokens, $openIndex, $closeIndex) as $segmentIndex => [$start, $end]) {
        $isNamed = $end - $start >= 2
            && $tokens[$start]['id'] === T_STRING
            && $tokens[$start + 1]['text'] === ':';
        $expressionStart = $isNamed ? $start + 2 : $start;
        $byteStart = $tokens[$expressionStart]['start'];
        $byteEnd = $tokens[$end]['end'];
        $argument = [
            'expression' => trim(substr($source, $byteStart, $byteEnd - $byteStart)),
            'signature' => tokenRangeSignature($tokens, $expressionStart, $end),
            'hasCallbackBody' => segmentContainsCallbackBody($tokens, $expressionStart, $end),
            'startByte' => $byteStart,
            'endByte' => $byteEnd,
        ];

        if ($isNamed) {
            $named[$tokens[$start]['text']] = $argument;
        } else {
            $positional[$segmentIndex] = $argument;
        }
    }

    return ['named' => $named, 'positional' => $positional];
}

/**
 * 取得 call receiver 起點；`$this->db->transaction(` 會回溯到 `$this`。
 */
function receiverStartIndex(array $tokens, int $index): int
{
    while (
        $index >= 2
        && in_array($tokens[$index - 1]['id'], [T_OBJECT_OPERATOR, T_NULLSAFE_OBJECT_OPERATOR], true)
        && tokenIsName($tokens[$index - 2])
    ) {
        $index -= 2;
    }

    return $index;
}

function extractCalls(string $source, string $path): array
{
    $tokens = significantTokens($source);
    $calls = [];
    $enclosingCloseIndexes = [];
    $objectOperators = [T_OBJECT_OPERATOR, T_NULLSAFE_OBJECT_OPERATOR];

    for ($index = 0; $index + 3 < count($tokens); $index += 1) {
        while ($enclosingCloseIndexes !== [] && end($enclosingCloseIndexes) < $index) {
            array_pop($enclosingCloseIndexes);
        }

        $left = $tokens[$index];
        $operator = $tokens[$index + 1];
        $method = $tokens[$index + 2];
        $open = $tokens[$index + 3];

        $isChained = $left['text'] === ')' && in_array($operator['id'], $objectOperators, true);
        if (
            (!$isChained && !tokenIsName($left))
            || !in_array($operator['id'], [...$objectOperators, T_DOUBLE_COLON], true)
            || $method['id'] !== T_STRING
            || $open['text'] !== '('
        ) {
            continue;
        }

        $closeIndex = findClosingParen($tokens, $index + 3);
        if ($closeIndex === null) {
            continue;
        }

        if ($isChained) {
            $receiverIndex = $index + 1;
            $callee = $operator['text'] . $method['text'];
        } else {
            $receiverIndex = receiverStartIndex($tokens, $index);
            $callee = '';
            for ($part = $receiverIndex; $part <= $index + 2; $part += 1) {
                $callee .= $tokens[$part]['text'];
            }
        }

        $isNested = $enclosingCloseIndexes !== [];
        $callEnd = $tokens[$closeIndex]['end'];
        $statementEnd = $callEnd;
        if (($tokens[$closeIndex + 1]['text'] ?? null) === ';') {
            $statementEnd = $tokens[$closeIndex + 1]['end'];
        }

        $previousText = $tokens[$receiverIndex - 1]['text'] ?? null;
        $isStandaloneStatement = !$isChained
            && $statementEnd > $callEnd
            && (
                $receiverIndex === 0
                || in_array($previousText, ['{', '}', ';', ':'], true)
            );
        // 巢狀 / 鏈式 call 只輸出 fact，不參與 masking，避免 mask range 重疊或放寬 completeness。
        $canMaskAsAtomicStatement = $isStandaloneStatement
            && !$isNested
            && !callContainsCallbackBody($tokens, $index + 3, $closeIndex);
        $arguments = callArguments($tokens, $index + 3, $closeIndex, $source);

        $calls[] = [
            'callee' => $callee,
            'subject' => subjectAtOffset($tokens, $tokens[$receiverIndex]['start'], $path),
            'startByte' => $tokens[$receiverIndex]['start'],
            'endByte' => $callEnd,
            'statementEndByte' => $statementEnd,
            'isStandaloneStatement' => $isStandaloneStatement,
            'canMaskAsAtomicStatement' => $canMaskAsAtomicStatement,
            'canMaskArguments' => !$isNested && !$isChained,
            'namedArguments' => $arguments['named'],
            'positionalArguments' => $arguments['positional'],
        ];

        $enclosingCloseIndexes[] = $closeIndex;
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
