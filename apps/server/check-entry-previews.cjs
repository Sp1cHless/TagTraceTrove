// 核实 T3 库里指定 Entry 的 preview 引用与磁盘实际尺寸
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const entryIds = process.argv.slice(2);
const db = new Database('.data/library.db', { readonly: true });

function assetsRoot() {
  return path.join('.data', 'assets', 'entries');
}

function resolveRef(ref) {
  // ref 形如 /api/assets/entries/<id>/<file>
  const m = /\/api\/assets\/entries\/(\d+)\/(.+)$/.exec(ref);
  if (!m) return null;
  return path.join(assetsRoot(), m[1], decodeURIComponent(m[2]));
}

function sizeOf(file) {
  // 用 sharp 探测尺寸
  const sharp = require('sharp');
  try {
    const meta = sharp(file);
    return meta.metadata();
  } catch (e) {
    return null;
  }
}

(async () => {
  for (const id of entryIds) {
    const row = db.prepare(
      'SELECT id, title, type, cover_ref, preview_ref, preview_refs FROM entries WHERE id = ?',
    ).get(Number(id));
    if (!row) {
      console.log(`#${id}: 不存在`);
      continue;
    }
    console.log(`\n#${row.id}  ${row.title}  [${row.type}]`);
    const refs = [];
    if (row.cover_ref) refs.push(['cover', row.cover_ref]);
    let previews = [];
    try { previews = JSON.parse(row.preview_refs || '[]'); } catch { previews = []; }
    if (previews.length === 0 && row.preview_ref) previews = [row.preview_ref];
    previews.forEach((r, i) => refs.push([`preview${i}`, r]));
    for (const [label, ref] of refs) {
      const file = resolveRef(ref);
      if (!file || !fs.existsSync(file)) {
        console.log(`  ${label}: ${ref} -> 文件缺失`);
        continue;
      }
      const meta = await sizeOf(file);
      const dim = meta ? `${meta.width}x${meta.height}` : '无法解码';
      const aspect = meta ? (meta.width / meta.height).toFixed(2) : '-';
      const bytes = fs.statSync(file).size;
      const suspect = meta ? (Math.min(meta.width, meta.height) < 64 || meta.width / meta.height > 12 || meta.width / meta.height < 1 / 12) : true;
      console.log(`  ${label}: ${dim} aspect=${aspect} ${bytes}B ${suspect ? '  <== 判定为异常' : ''}  (${path.basename(file)})`);
    }
  }
  db.close();
})();
