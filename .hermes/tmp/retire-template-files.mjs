// Move the retired Gallery's exported template files aside (reversible: they are copied, not deleted).
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const from = 'D:/Project/TagTraceTrove/apps/server/.data/templates';
const to = 'D:/Project/TagTraceTrove/.hermes/tmp/retired-template';
mkdirSync(to, { recursive: true });

for (const name of ['template专用.template.json', 'template专用.tag-layout.json']) {
  copyFileSync(join(from, name), join(to, name));
  rmSync(join(from, name));
  console.log(`moved ${name} -> .hermes/tmp/retired-template/`);
}
