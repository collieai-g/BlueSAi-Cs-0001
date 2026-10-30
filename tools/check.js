import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const nonSourceDirectories = new Set(['node_modules', '.git', '__pycache__']);
function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? nonSourceDirectories.has(entry.name) ? [] : scripts(join(dir, entry.name))
    : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
}
for (const path of ['src', 'public', 'tools', 'integrations/whatsapp-local'].flatMap(scripts)) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('All source, public and tool JavaScript syntax checks passed.');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const generated = spawnSync(python, ['-B', 'tools/build-workbench.py', '--check'], { stdio: 'inherit' });
if (generated.error) console.error('Python 3.12+ is required to check generated UI assets.');
if (generated.status !== 0) process.exit(generated.status || 1);
