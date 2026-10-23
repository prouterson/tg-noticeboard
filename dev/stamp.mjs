// Stamps the board's version so the iPad notices new code and loads it (see checkVersion in index.html).
// Hashes the board files, then writes the hash into index.html (BUILD and the ?v= on its scripts)
// and into version.json. Runs from the git pre-commit hook (.githooks/pre-commit); safe to run by hand:
//   node dev/stamp.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(root, f), 'utf8');
const BUILD_RE = /var BUILD = "[^"]*";/;
const V_RE = /(src="(?:config|checkin)\.js)\?v=[^"]*"/g;

let page = read('index.html');
if (!BUILD_RE.test(page)) throw new Error('index.html has no `var BUILD = "...";` line');
const neutral = page.replace(BUILD_RE, 'var BUILD = "";').replace(V_RE, '$1?v="').replace(/\r\n/g, '\n');
const build = createHash('sha256')
  .update(neutral).update(read('checkin.js').replace(/\r\n/g, '\n')).update(read('config.js').replace(/\r\n/g, '\n'))
  .digest('hex').slice(0, 10);

page = page.replace(BUILD_RE, `var BUILD = "${build}";`).replace(V_RE, `$1?v=${build}"`);
writeFileSync(join(root, 'index.html'), page);
writeFileSync(join(root, 'version.json'), JSON.stringify({ build }) + '\n');
console.log(`board build ${build}`);
