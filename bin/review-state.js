#!/usr/bin/env node
import process from 'node:process';

import { run } from '../src/cli/review-state.js';

await run(process.argv.slice(2));
