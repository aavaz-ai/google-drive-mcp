import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  GOOGLE_DRIVE_MCP_PACKAGE_NAME,
  GOOGLE_DRIVE_MCP_VERSION,
  GOOGLE_DRIVE_SCOPE,
} from '../../src/managedContract.js';

const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  main?: string;
  exports?: Record<string, unknown>;
  bin: Record<string, string>;
  files: string[];
  engines: Record<string, string>;
  publishConfig: Record<string, string>;
  repository?: { type: string; url: string };
  homepage?: string;
  bugs?: { url: string };
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
};

describe('published package contract', () => {
  it('keeps managed identity and the only approved OAuth scope exact', () => {
    expect(packageJson.name).toBe(GOOGLE_DRIVE_MCP_PACKAGE_NAME);
    expect(packageJson.version).toBe(GOOGLE_DRIVE_MCP_VERSION);
    expect(GOOGLE_DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('is CLI-only and points npm users to the Enterpret fork', () => {
    expect(packageJson.main).toBeUndefined();
    expect(packageJson.exports).toEqual({});
    expect(packageJson.scripts.auth).toBeUndefined();
    expect(packageJson.bin).toEqual({ 'google-drive-mcp': './dist/index.js' });
    expect(packageJson.engines).toEqual({ node: '>=22' });
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/aavaz-ai/google-drive-mcp.git',
    });
    expect(packageJson.homepage).toBe('https://github.com/aavaz-ai/google-drive-mcp#readme');
    expect(packageJson.bugs).toEqual({
      url: 'https://github.com/aavaz-ai/google-drive-mcp/issues',
    });
  });

  it('ships only the managed executable and release documentation', () => {
    expect(packageJson.files).toEqual([
      'dist/',
      'README.md',
      'README_UPSTREAM.md',
      'ENTERPRET.md',
      'CHANGELOG.md',
      'CHANGELOG_ENTERPRET.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
    ]);
  });

  it('ships only managed runtime dependencies', () => {
    expect(Object.keys(packageJson.dependencies).sort()).toEqual([
      '@modelcontextprotocol/sdk',
      'zod',
    ]);
    expect(packageJson.overrides).toMatchObject({
      '@hono/node-server': '^2.0.5',
      'body-parser': '^2.3.0',
      uuid: '^11.1.1',
    });
  });
});
