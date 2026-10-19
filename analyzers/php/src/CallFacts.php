<?php

declare(strict_types=1);

namespace Reviewer\PhpAnalyzer;

/**
 * 依 slot（subject + 所在的 closure，見 CallExtractor）+ callee 分組配對 before / after calls，
 * 輸出 generic call facts：CALL_REMOVED、CALL_ADDED，以及 named argument 的 CALL_ARGUMENT_CHANGED。
 */
final class CallFacts
{
    /**
     * 每筆 call 加上配對用的 `slot`：subject 加上所在 closure 的錨點鏈中、兩側都存在的最長前綴。
     *
     * 只有兩側都存在的 closure 才分開配對。closure 只存在於一側時（新增或移除 `DB::transaction(function () { … })`
     * 這類包裝、路由路徑等錨點改變），其中的 call 與外層一起配對：解開包裝時原本在裡面的 call 不會被當成
     * 移除 + 新增，結果與不分 closure 配對時相同。
     *
     * @param array{calls: list<array<string, mixed>>, closures: array<string, true>} $before CallExtractor::extract() 的結果。
     * @param array{calls: list<array<string, mixed>>, closures: array<string, true>} $after
     * @return array{0: list<array<string, mixed>>, 1: list<array<string, mixed>>} 加上 `slot` 的 before / after calls。
     */
    public static function assignSlots(array $before, array $after): array
    {
        $slotted = static function (array $calls, array $otherClosures): array {
            return array_map(static function (array $call) use ($otherClosures): array {
                $chain = $call['chain'];
                while ($chain !== [] && !isset($otherClosures[CallExtractor::closureKey($call['subject'], $chain)])) {
                    array_pop($chain);
                }
                $call['slot'] = CallExtractor::closureKey($call['subject'], $chain);

                return $call;
            }, $calls);
        };

        return [$slotted($before['calls'], $after['closures']), $slotted($after['calls'], $before['closures'])];
    }

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
                    $facts[] = self::fact($path, 'CALL_ARGUMENT_CHANGED', $afterCall, $afterCall['callee']['text'] . ':' . $argument, [
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
            $groups[$call['slot'] . '|' . $call['calleeKey']][] = $call;
        }

        return $groups;
    }

    /**
     * @param array<string, mixed> $call
     * @return array<string, mixed>
     */
    private static function callFact(string $path, string $kind, string $side, array $call, int $callIndex): array
    {
        return self::fact($path, $kind, $call, $call['callee']['text'] . ':' . $callIndex, [
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
            // 內部配對 key（StructuralDiff budget 用），輸出前移除。
            'calleeKey' => $call['calleeKey'],
            'slot' => $call['slot'],
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
