// 删除「临时」collection 里的 entry（走 T³ 自己的 DELETE 路由，顺带清理 .data/assets）。
// 用法：node delete-temp-entries.mjs <id列表文件> [baseUrl]
import { readFileSync } from 'node:fs';

const listPath = process.argv[2];
const base = process.argv[3] ?? 'http://127.0.0.1:8765';
const ids = readFileSync(listPath, 'utf-8').trim().split(/\s+/).filter(Boolean).map(Number);
console.log(`准备删除 ${ids.length} 个 entry，目标 ${base}`);

let deleted = 0;
const failures = [];
for (const [index, id] of ids.entries()) {
  try {
    const response = await fetch(`${base}/api/entries/${id}`, { method: 'DELETE' });
    if (response.ok) {
      deleted += 1;
    } else {
      failures.push({ id, status: response.status, body: (await response.text()).slice(0, 120) });
    }
  } catch (error) {
    failures.push({ id, status: 'error', body: String(error).slice(0, 120) });
  }
  if ((index + 1) % 50 === 0) console.log(`  已处理 ${index + 1}/${ids.length}，成功 ${deleted}`);
}

console.log(`\n完成：成功删除 ${deleted}，失败 ${failures.length}`);
for (const failure of failures.slice(0, 10)) console.log('  ', JSON.stringify(failure));
if (failures.length) process.exitCode = 1;
