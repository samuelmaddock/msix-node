#!/usr/bin/env node

const { promises: fs, createReadStream } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const util = require('node:util');
const cp = require('node:child_process');
const exec = util.promisify(cp.exec);

const outDir = path.join(__dirname, 'build-tmp-msix');
const scriptName = 'main.js';
const seaBlobName = 'sea-prep.blob';
const exeName = 'msixnode.exe';

async function readFileChecksum(filePath) {
  return new Promise((resolve, reject) => {
    createReadStream(filePath)
      .pipe(crypto.createHash('md5'))
      .on('readable', function () {
        const buf = this.read();
        if (!buf) return; // ignore EOF
        const hash = buf.toString('hex');
        resolve(hash);
      })
      .once('error', reject);
  });
}

async function prepareScript() {
  try {
    await fs.stat(outDir);
  } catch {
    await fs.mkdir(outDir);
  }

  const script = await fs.readFile(
    path.join(__dirname, 'msix-node.js'),
    'utf8'
  );

  // Allow the original test script to alter behavior for MSIX
  const preload = `
__sea = true;
__srcdirname = ${JSON.stringify(__dirname)};
`;

  const compiledScript = preload + script;
  await fs.writeFile(path.join(outDir, scriptName), compiledScript);
}

async function createTestSea() {
  // Node v1x.y.z unsupported
  if (/^v1\d\./.test(process.version)) {
    throw new Error('Node v20 required to create executable.');
  }

  // write config
  await fs.writeFile(
    path.join(outDir, 'sea-config.json'),
    Buffer.from(`{ "main": "${scriptName}", "output": "${seaBlobName}" }`)
  );

  let prevBlobChecksum;
  const seaBlobPath = path.join(outDir, seaBlobName);

  try {
    const seaBlobStat = await fs.stat(seaBlobPath);
    if (seaBlobStat.isFile()) {
      prevBlobChecksum = await readFileChecksum(seaBlobPath);
    }
  } catch {}

  await exec('node --experimental-sea-config sea-config.json', { cwd: outDir });

  const blobChecksum = await readFileChecksum(seaBlobPath);

  // Skip long process of preparing exe if assets are the same
  if (prevBlobChecksum === blobChecksum) {
    console.debug(`Skipping ${exeName} rebuild (blob checksums match)`);
    return false;
  }

  await fs.cp(process.execPath, path.join(outDir, exeName));

  // Remove signature from node.exe
  // TODO: signtool isn't in path and this doesn't seem necessary so skipping
  // this step for now.
  // try {
  //   await exec(`signtool remove /s ${exeName}`, { cwd: outDir });
  // } catch (error) {
  //   console.warn(`Removing exe signature failed:\n\t`, error.message);
  // }

  console.info(`Building ${exeName}…`);
  await exec(
    `npx postject ${exeName} NODE_SEA_BLOB ${seaBlobName} --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { cwd: outDir }
  );

  return true;
}

/**
 * Register AppX package to grant the app an identity.
 *
 * Requires Windows Development Mode to be enabled.
 * https://learn.microsoft.com/en-us/windows/apps/get-started/enable-your-device-for-development#activate-developer-mode
 *
 * Useful commands:
 *  Add-AppxPackage –Register AppxManifest.xml -ForceUpdateFromAnyVersion
 *  Get-AppxPackage -Name SamuelMaddock.GitHub.MsixNode
 */
async function registerAppx() {
  console.log('Registering Appx package…');

  // If this fails, try incrementing the version in the manifest.
  await exec(
    'Add-AppxPackage –Register AppxManifest.xml -ForceUpdateFromAnyVersion',
    {
      shell: 'powershell.exe',
    }
  );
}

async function runExe() {
  console.log('Running packaged node…\n');
  const [, ...args] = process.argv;
  const p = cp.spawn(exeName, args);
  await new Promise((resolve, reject) => {
    p.stdout.pipe(process.stdout);
    p.stderr.pipe(process.stderr);
    p.on('exit', (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(`msix-node exited with exitCode=${exitCode}`);
      }
    });
  });
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('msix-node only supported on Windows.');
  }

  // TODO: check if developer mode is enabled

  try {
    await prepareScript();
  } catch (error) {
    console.error('Error compiling msix-node script.');
    throw error;
  }

  let updatedSea = false;
  try {
    updatedSea = await createTestSea();
  } catch (error) {
    console.error('Error creating node executable.');
    throw error;
  }

  // Skip appx registration if SEA wasn't updated.
  if (updatedSea) {
    try {
      await registerAppx();
    } catch (error) {
      console.error('Error registering AppX package.');
      throw error;
    }
  }

  await runExe();
}

main();
