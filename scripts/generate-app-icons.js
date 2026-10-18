import sharp from 'sharp';
import { access, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
let source = new URL('assets/app-icon/icon.png', root);
try { await access(source); }
catch { source = new URL('public/logo/logo.png', root); }
const { width, height } = await sharp(fileURLToPath(source)).metadata();
if (!width || width !== height) throw new Error('El ícono debe ser cuadrado.');
await mkdir(new URL('public/icons/', root), { recursive: true });
for (const [name, size, inset] of [
  ['icon-192.png', 192, 0], ['icon-512.png', 512, 0],
  ['apple-touch-icon.png', 180, 0], ['favicon-32.png', 32, 0],
  ['maskable-512.png', 512, 0.15],
]) {
  const padding = Math.round(size * inset);
  await sharp(fileURLToPath(source))
    .resize(size - padding * 2, size - padding * 2)
    .flatten({ background: '#ffffff' })
    .extend({ top: padding, bottom: padding, left: padding, right: padding, background: '#ffffff' })
    .png().toFile(fileURLToPath(new URL(`public/icons/${name}`, root)));
}
console.log(`Íconos generados desde ${fileURLToPath(source)}`);
