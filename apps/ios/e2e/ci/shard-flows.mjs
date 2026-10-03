// Prints the flows one iOS e2e shard runs, one path per line (relative to
// apps/ios): every flow tagged `ci`, minus the ones a job runs by itself
// in a fixed position (`ci-bootstrap`, `ci-permissions`), split by position
// in the sorted file list. A new flow lands in a shard without being
// registered anywhere.
//
//   node e2e/ci/shard-flows.mjs <shard> <total>     (shard is 1-based)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const [shard, total] = process.argv.slice(2).map(Number);
if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || shard > total) {
  process.stderr.write('usage: shard-flows.mjs <shard> <total>, with 1 <= shard <= total\n');
  process.exit(1);
}

const flowsDir = fileURLToPath(new URL('../flows', import.meta.url));

/** The tags in a flow's header (the YAML document before `---`). */
const tagsOf = (file) => {
  const header = readFileSync(join(flowsDir, file), 'utf8').split(/^---$/m)[0] ?? '';
  const block = /^tags:\n((?:[ \t]+-[^\n]*\n?)+)/m.exec(header)?.[1] ?? '';
  return block.split('\n').flatMap((line) => {
    const tag = line.replace(/^[ \t]+-[ \t]*/, '').trim();
    return tag === '' ? [] : [tag];
  });
};

const flows = readdirSync(flowsDir)
  .filter((file) => file.endsWith('.yaml'))
  .sort()
  .filter((file) => {
    const tags = tagsOf(file);
    return (
      tags.includes('ci') && !tags.includes('ci-bootstrap') && !tags.includes('ci-permissions')
    );
  });

for (const [position, file] of flows.entries()) {
  if (position % total === shard % total) {
    process.stdout.write(`e2e/flows/${file}\n`);
  }
}
