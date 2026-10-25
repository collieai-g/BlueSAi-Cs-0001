import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function scripts(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? scripts(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
}
for (const path of ['src', 'public', 'tools', 'integrations/whatsapp-local'].flatMap(scripts)) {
  const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('All source, public and tool JavaScript syntax checks passed.');
