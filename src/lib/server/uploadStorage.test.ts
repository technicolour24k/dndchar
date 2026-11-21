import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { overworldImageDir, resetUploadDirWarning, uploadDir, uploadDirIsEphemeral } from './uploadStorage';

const CAMPAIGN = '11111111-2222-4333-8444-555555555555';
const original = { UPLOAD_DIR: process.env.UPLOAD_DIR, NODE_ENV: process.env.NODE_ENV };

function setEnv(name: 'UPLOAD_DIR' | 'NODE_ENV', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env.UPLOAD_DIR;
  resetUploadDirWarning();
});
afterEach(() => {
  setEnv('UPLOAD_DIR', original.UPLOAD_DIR);
  setEnv('NODE_ENV', original.NODE_ENV);
  vi.restoreAllMocks();
});

describe('uploadDir', () => {
  it('uses UPLOAD_DIR when it is set', () => {
    const dir = path.resolve('some', 'abs', 'dir');
    process.env.UPLOAD_DIR = dir;
    expect(uploadDir()).toBe(dir);
  });
  it('falls back to <cwd>/data when unset', () => {
    expect(uploadDir()).toBe(path.join(process.cwd(), 'data'));
  });
  it('rejects a relative UPLOAD_DIR with a clear error', () => {
    process.env.UPLOAD_DIR = 'data/uploads';
    expect(() => uploadDir()).toThrow(/UPLOAD_DIR must be an absolute path/);
  });
  it('warns once in production when unset, and not at all when it is set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    expect(uploadDirIsEphemeral()).toBe(true);
    uploadDir();
    uploadDir();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('UPLOAD_DIR is not set');

    warn.mockClear();
    resetUploadDirWarning();
    process.env.UPLOAD_DIR = path.resolve('some', 'abs', 'dir');
    expect(uploadDirIsEphemeral()).toBe(false);
    uploadDir();
    expect(warn).not.toHaveBeenCalled();
  });
  it('does not warn outside production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.NODE_ENV = 'development';
    uploadDir();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('overworldImageDir', () => {
  it('is <uploadDir>/overworld/<campaignId>', () => {
    const root = path.resolve('some', 'abs', 'dir');
    process.env.UPLOAD_DIR = root;
    expect(overworldImageDir(CAMPAIGN)).toBe(path.join(root, 'overworld', CAMPAIGN));
  });
  it('rejects anything that is not a uuid', () => {
    expect(() => overworldImageDir('../etc')).toThrow();
    expect(() => overworldImageDir('')).toThrow();
    expect(() => overworldImageDir(`${CAMPAIGN}/..`)).toThrow();
  });
});
