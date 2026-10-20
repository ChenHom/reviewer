#!/usr/bin/env node
import process from 'node:process';

import { packageVersion } from '../src/cli/doctor.js';

const COMMANDS = {
  review: () => import('./review.js'),
  state: () => import('./review-state.js'),
  retro: () => import('./retro.js'),
  doctor: () => import('../src/cli/doctor.js'),
};

const USAGE = `用法：reviewer <指令> [options]

  review   Review 一個 PR 的變更，列出需要人工 review 的檔案與原因
  state    以 review 的報表計算二次 review 的狀態（人工確認、置頂儀表板、Check）
  retro    彙整一段期間的報表，找出可以強化或精簡的地方
  doctor   檢查執行環境（git、TS/JS 與 PHP analyzer 的依賴），缺少時說明怎麼安裝

  reviewer <指令> --help   指令的用法
  reviewer --version       版本

exit code：見各指令；沒有指令或指令不認得時為 2。`;

const [command, ...rest] = process.argv.slice(2);
if (command === '--help' || command === '-h') {
  process.stdout.write(`${USAGE}\n`);
} else if (command === '--version' || command === '-v') {
  process.stdout.write(`${packageVersion()}\n`);
} else if (command === undefined) {
  process.stderr.write(`${USAGE}\n`);
  process.exitCode = 2;
} else if (!Object.hasOwn(COMMANDS, command)) {
  process.stderr.write(`error: COMMAND_UNKNOWN:${command}\n執行 reviewer --help 查看可用的指令\n`);
  process.exitCode = 2;
} else {
  const { run } = await COMMANDS[command]();
  await run(rest);
}
