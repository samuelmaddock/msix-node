const { promises: fs } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

function main() {
  const nodeRequire = createRequire(__filename);
  const [, , , ...args] = process.argv;

  // Currently we're only accepting a script as the first argument. Eventually
  // support for an eval string and REPL could be added.
  const [script] = args;
  const scriptPath = path.isAbsolute(script)
    ? script
    : path.join(process.cwd(), script);
  nodeRequire(scriptPath);
}

main();
