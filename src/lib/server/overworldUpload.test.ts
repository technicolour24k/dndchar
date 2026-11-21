import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OverworldError } from './overworldError';
import {
  isSafeImageFileName,
  removeImageFile,
  sniffStoredImageType,
  storeImageThenRun,
  validateUpload,
  writeImageFile
} from './overworldUpload';

const CAMPAIGN = '11111111-2222-4333-8444-555555555555';
let root = '';
const originalDir = process.env.UPLOAD_DIR;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'overworld-upload-test-'));
  process.env.UPLOAD_DIR = root;
});
afterAll(async () => {
  if (originalDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = originalDir;
  await fs.rm(root, { recursive: true, force: true });
});

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
// Smallest thing the sniffer accepts as a PNG of the given size (signature + IHDR).
function png(width: number, height: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [0, 0, 0, 13, ...'IHDR'.split('').map((c) => c.charCodeAt(0)), ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  return Uint8Array.from([...sig, ...ihdr]);
}
const file = (bytes: Uint8Array | string, name: string, type: string) => new File([bytes as BlobPart], name, { type });

async function rejects(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e) => e);
  expect(error).toBeInstanceOf(OverworldError);
  expect((error as OverworldError).code).toBe(code);
}

describe('validateUpload', () => {
  it('accepts a PNG and returns the sniffed size and extension', async () => {
    const result = await validateUpload(file(png(1200, 800), 'map.png', 'image/png'));
    expect(result).toMatchObject({ ext: 'png', width: 1200, height: 800 });
    expect(result.buffer.length).toBe(png(1200, 800).length);
  });
  it('stores PNG bytes declared as JPEG with the sniffed (.png) extension', async () => {
    const result = await validateUpload(file(png(100, 100), 'sneaky.jpg', 'image/jpeg'));
    expect(result.ext).toBe('png');
  });
  it('rejects no file, an empty file and a wrong declared type', async () => {
    await rejects(validateUpload(null), 'bad_image');
    await rejects(validateUpload(file(new Uint8Array(), 'a.png', 'image/png')), 'bad_image');
    await rejects(validateUpload(file(png(10, 10), 'a.gif', 'image/gif')), 'bad_image');
  });
  it('rejects an SVG or HTML body even when declared as an image', async () => {
    await rejects(validateUpload(file('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'a.png', 'image/png')), 'bad_image');
    await rejects(validateUpload(file('<html><script>alert(1)</script></html>', 'a.jpg', 'image/jpeg')), 'bad_image');
  });
  it('rejects an oversized file (over 15 MB)', async () => {
    const big = new Uint8Array(15 * 1024 * 1024 + 1);
    big.set(png(10, 10));
    await rejects(validateUpload(file(big, 'big.png', 'image/png')), 'too_large');
  });
  it('rejects a 7000 px wide image and one over 20 megapixels', async () => {
    await rejects(validateUpload(file(png(7000, 100), 'wide.png', 'image/png')), 'too_large');
    await rejects(validateUpload(file(png(5900, 5900), 'mp.png', 'image/png')), 'too_large');
    // At the limits is fine.
    expect((await validateUpload(file(png(6000, 3333), 'ok.png', 'image/png'))).width).toBe(6000);
  });
  it('rejects a truncated header', async () => {
    await rejects(validateUpload(file(png(10, 10).slice(0, 12), 'a.png', 'image/png')), 'bad_image');
  });
});

describe('file handling', () => {
  const image = async () => validateUpload(file(png(64, 64), 'a.png', 'image/png'));

  it('writes under <UPLOAD_DIR>/overworld/<campaign>/ with a timestamp-random name', async () => {
    const name = await writeImageFile(CAMPAIGN, await image());
    expect(name).toMatch(/^\d+-[0-9a-f]{12}\.png$/);
    expect(isSafeImageFileName(name)).toBe(true);
    await fs.access(path.join(root, 'overworld', CAMPAIGN, name));
  });
  it('removes the file again when the database step fails', async () => {
    let written = '';
    await expect(
      storeImageThenRun(CAMPAIGN, await image(), async (name) => {
        written = name;
        await fs.access(path.join(root, 'overworld', CAMPAIGN, name));
        throw new Error('db down');
      })
    ).rejects.toThrow('db down');
    await expect(fs.access(path.join(root, 'overworld', CAMPAIGN, written))).rejects.toThrow();
  });
  it('removes a partially written file when the write itself fails', async () => {
    const dir = path.join(root, 'overworld', CAMPAIGN);
    await fs.mkdir(dir, { recursive: true });
    const before = await fs.readdir(dir);
    const realWrite = fs.writeFile.bind(fs);
    // Leave half a file behind, then fail, like a disk filling up mid-write.
    const spy = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (p, _data, opts) => {
      await realWrite(p as string, 'partial', opts as any);
      throw new Error('ENOSPC: no space left on device');
    });
    await expect(writeImageFile(CAMPAIGN, await image())).rejects.toThrow('ENOSPC');
    spy.mockRestore();
    expect(await fs.readdir(dir)).toEqual(before);
  });
  it('keeps the file when the database step succeeds', async () => {
    const name = await storeImageThenRun(CAMPAIGN, await image(), async (n) => n);
    await fs.access(path.join(root, 'overworld', CAMPAIGN, name));
    await removeImageFile(CAMPAIGN, name);
    await expect(fs.access(path.join(root, 'overworld', CAMPAIGN, name))).rejects.toThrow();
    // Deleting something that is already gone, or an unsafe name, is quietly fine.
    await removeImageFile(CAMPAIGN, name);
    await removeImageFile(CAMPAIGN, '../../etc/passwd');
  });
  it('isSafeImageFileName matches the migration CHECK', () => {
    expect(isSafeImageFileName('1700000000000-abcdef012345.webp')).toBe(true);
    for (const bad of ['../x', '..', '.hidden', 'a/b.png', 'a b.png', '', 'a..b.png']) expect(isSafeImageFileName(bad)).toBe(false);
  });
  it('sniffStoredImageType reads the bytes, not the name', async () => {
    const name = await writeImageFile(CAMPAIGN, await image());
    const p = path.join(root, 'overworld', CAMPAIGN, name);
    expect(await sniffStoredImageType(p)).toBe('image/png');
    // A file named .png that holds HTML is not served as an image.
    const fake = path.join(root, 'fake.png');
    await fs.writeFile(fake, '<html>hi</html>');
    expect(await sniffStoredImageType(fake)).toBeNull();
    expect(await sniffStoredImageType(path.join(root, 'missing.png'))).toBeNull();
  });
});
