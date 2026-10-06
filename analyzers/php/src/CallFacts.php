<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

/**
 * 依 subject + callee 分組配對 before / after calls，輸出 generic call facts：
 * CALL_REMOVED、CALL_ADDED，以及 named argument 的 CALL_ARGUMENT_CHANGED。
 */
final class CallFacts
{
    /**
     * @param list<array<string, mixed>> $beforeCalls
     * @param list<array<string, mixed>> $afterCalls
     * @return list<array<string, mixed>>
     */
    public static function build(string $path, array $beforeCalls, array $afterCalls): array
    {
        $facts = [];
        $beforeGroups = self::group($beforeCalls);
        $afterGroups = self::group($afterCalls);

        foreach ($beforeGroups as $key => $beforeGroup) {
            $afterGroup = $afterGroups[$key] ?? [];
            $pairCount = min(count($beforeGroup), count($afterGroup));

            for ($pairIndex = 0; $pairIndex < $pairCount; $pairIndex += 1) {
                $beforeCall = $beforeGroup[$pairIndex];
                $afterCall = $afterGroup[$pairIndex];

                foreach ($beforeCall['namedArguments'] as $argument => $beforeArgument) {
                    $afterArgument = $afterCall['namedArguments'][$argument] ?? null;
                    if ($afterArgument === null || $beforeArgument['signature'] === $afterArgument['signature']) {
                        continue;
                    }
                    $facts[] = self::fact($path, 'CALL_ARGUMENT_CHANGED', $afterCall, $afterCall['callee'] . ':' . $argument, [
                        'callee' => $afterCall['callee'],
                        'argument' => $argument,
                        'before' => $beforeArgument['expression'],
                        'after' => $afterArgument['expression'],
                        'changeSide' => 'after',
                    ], $afterArgument['startByte'], $afterArgument['endByte']);
                }
            }

            for ($callIndex = $pairCount; $callIndex < count($beforeGroup); $callIndex += 1) {
                $facts[] = self::callFact($path, 'CALL_REMOVED', 'before', $beforeGroup[$callIndex], $callIndex);
            }
            for ($callIndex = $pairCount; $callIndex < count($afterGroup); $callIndex += 1) {
                $facts[] = self::callFact($path, 'CALL_ADDED', 'after', $afterGroup[$callIndex], $callIndex);
            }
        }

        foreach ($afterGroups as $key => $afterGroup) {
            if (array_key_exists($key, $beforeGroups)) {
                continue;
            }
            foreach ($afterGroup as $callIndex => $call) {
                $facts[] = self::callFact($path, 'CALL_ADDED', 'after', $call, $callIndex);
            }
        }

        return $facts;
    }

    /**
     * @param list<array<string, mixed>> $calls
     * @return array<string, list<array<string, mixed>>>
     */
    private static function group(array $calls): array
    {
        $groups = [];
        foreach ($calls as $call) {
            $groups[$call['subject'] . '|' . $call['callee']][] = $call;
        }

        return $groups;
    }

    /**
     * @param array<string, mixed> $call
     * @return array<string, mixed>
     */
    private static function callFact(string $path, string $kind, string $side, array $call, int $callIndex): array
    {
        return self::fact($path, $kind, $call, $call['callee'] . ':' . $callIndex, [
            'callee' => $call['callee'],
            'changeSide' => $side,
        ], $call['startByte'], $call['statementEndByte']);
    }

    /**
     * @param array<string, mixed> $call
     * @param array<string, mixed> $properties
     * @return array<string, mixed>
     */
    private static function fact(
        string $path,
        string $kind,
        array $call,
        string $detail,
        array $properties,
        int $startByte,
        int $endByte,
    ): array {
        return [
            'id' => 'php-' . substr(
                hash('sha256', implode('|', [$kind, $path, $call['subject'], $detail, $startByte, $endByte])),
                0,
                20,
            ),
            'kind' => $kind,
            'subject' => $call['subject'],
            'properties' => $properties,
            'provenance' => [
                'path' => $path,
                'startByte' => $startByte,
                'endByte' => $endByte,
            ],
        ];
    }
}
