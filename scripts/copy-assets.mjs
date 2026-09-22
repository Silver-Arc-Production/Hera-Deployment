/**
 * Copy non-TypeScript assets into ``dist`` after ``tsc`` runs.
 *
 * ``tsc`` only emits JavaScript, so the dashboard's static pages would be missing
 * from a production build without this step. The bot itself has no assets.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jobs = [['dashboard/static', 'dist/dashboard/static']];

for (const [from, to] of jobs) {
  const source = join(root, from);
  if (!existsSync(source)) continue;
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
