// make-sums.mjs — 生成 sha256sum 兼容的校验和文件（小写十六进制 + LF，可直接 `sha256sum -c`）
// 用法：node tools/make-sums.mjs <输出文件> <文件...>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const [out, ...files] = process.argv.slice(2);
if (!out || files.length === 0) {
  console.error('用法：node tools/make-sums.mjs <输出文件> <文件...>');
  process.exit(2);
}
const lines = [`# SHA-256 checksums (dsh-VRChat-vplay ${new Date().toISOString().slice(0, 10)})`, '# verify: sha256sum -c SHA256SUMS.txt'];
for (const file of files) {
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  lines.push(`${hash}  ${basename(file)}`);
}
writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
console.log(`wrote ${out}`);
