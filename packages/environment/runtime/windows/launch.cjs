const { spawn } = require('node:child_process');
const request = JSON.parse(process.argv[2]);
const child = spawn(request.command, request.args, { stdio: 'inherit' });
child.once('error', error => { throw error; });
child.once('close', code => { process.exitCode = code ?? 1; });
