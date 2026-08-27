#!/usr/bin/env node

import { runMaybeCode } from "./run.js";

process.exitCode = await runMaybeCode(process.argv.slice(2));
