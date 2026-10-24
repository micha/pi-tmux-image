// Generated two-page asymmetric labelled PDF snapshots, private temporary files only.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function pdfSnapshots(withPdfPages) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-pacing-pdf-'));
  const path = join(directory, 'coordinate-fixture.pdf');
  try {
    const content = (width, height, label) => {
      let text = `0.8 0.1 0.1 rg 0 0 ${width / 3} ${height} re f\n0.1 0.2 0.8 rg ${width / 3} 0 ${width * 2 / 3} ${height / 2} re f\n`;
      for (let x = 0; x < width; x += 12) text += `0.2 0.6 0.2 RG ${x} 0 m ${x} ${height} l S\n`;
      for (let y = 0; y < height; y += 12) text += `0.2 0.6 0.2 RG 0 ${y} m ${width} ${y} l S\n`;
      return text + `0 0 0 rg BT /F1 8 Tf 4 ${height - 10} Td (${label}) Tj ET\n`;
    };
    const streams = [content(144, 72, 'PAGE 1: LANDSCAPE TOP LEFT'), content(72, 144, 'PAGE 2: PORTRAIT TOP LEFT')];
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 144 72] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 144] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
      ...streams.map((stream) => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`),
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let data = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((body, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${body}\nendobj\n`; });
    const xref = Buffer.byteLength(data);
    data += `xref\n0 8\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    data += `trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    await writeFile(path, data);
    const pages = await withPdfPages(path, async (png, page) => ({ page, png: await readFile(png) }));
    if (pages.length !== 2) throw new Error('Generated PDF did not produce exactly two snapshots');
    return new Map(pages.map(({ page, png }) => [`pdf-page-${page}`, png]));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
