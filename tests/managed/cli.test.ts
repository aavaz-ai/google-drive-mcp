import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { GOOGLE_DRIVE_TOOL_NAMES } from '../../src/managedContract.js';

const DIST_INDEX = join(process.cwd(), 'dist', 'index.js');
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }).version;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function cleanEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { GOOGLE_DRIVE_OAUTH_BEARER: _bearer, MCP_TESTING: _testing, ...environment } = process.env;
  return { ...environment, ...extra };
}

function runCli(args: string[], environment: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST_INDEX, ...args], {
      env: cleanEnvironment(environment),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('managed CLI did not exit'));
    }, 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on('exit', (exitCode) => {
      clearTimeout(deadline);
      resolve({ stdout, stderr, exitCode });
    });
  });
}

describe('managed CLI', () => {
  it('prints managed help and version without requiring a bearer', async () => {
    const help = await runCli(['--help']);
    expect(help).toMatchObject({ exitCode: 0, stderr: '' });
    expect(help.stdout).toContain('stdio-only');
    expect(help.stdout).toContain('GOOGLE_DRIVE_OAUTH_BEARER');

    const version = await runCli(['--version']);
    expect(version).toMatchObject({ exitCode: 0, stdout: PACKAGE_VERSION + '\n', stderr: '' });
  });

  it.each([
    ['missing', {}],
    ['blank', { GOOGLE_DRIVE_OAUTH_BEARER: '   ' }],
  ])('fails safely with a %s bearer and keeps stdout empty', async (_name, environment) => {
    const result = await runCli([], environment);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('@enterpret/google-drive-mcp: startup failed safely\n');
  });

  it.each([
    ['auth'],
    ['--transport', 'http'],
    ['--team'],
    ['--port', '8080'],
    ['--http'],
  ])('rejects upstream-only CLI arguments: %j', async (...args) => {
    const result = await runCli(args, { GOOGLE_DRIVE_OAUTH_BEARER: 'CLI_TEST_BEARER' });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('@enterpret/google-drive-mcp: startup failed safely\n');
    expect(result.stderr).not.toContain('CLI_TEST_BEARER');
  });

  it('initializes and lists the exact managed tools with JSON-RPC-only stdout', async () => {
    const child = spawn(process.execPath, [DIST_INDEX], {
      env: cleanEnvironment({ GOOGLE_DRIVE_OAUTH_BEARER: 'CLI_DISCOVERY_BEARER' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const messages: Array<Record<string, unknown>> = [];
    const result = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('timed out waiting for tools/list')), 10_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        try {
          for (const line of lines.filter((value) => value.length > 0)) {
            const message = JSON.parse(line) as Record<string, unknown>;
            messages.push(message);
            if (message.id === 2) {
              clearTimeout(deadline);
              resolve();
            }
          }
        } catch (error) {
          clearTimeout(deadline);
          reject(error);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!messages.some((message) => message.id === 2)) {
          reject(new Error('managed CLI exited early: ' + String(code)));
        }
      });
    });

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'managed-cli-test', version: '1.0.0' },
      },
    }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');

    try {
      await result;
      const listResponse = messages.find((message) => message.id === 2);
      const tools = ((listResponse?.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []);
      expect(tools.map((tool) => tool.name)).toEqual(GOOGLE_DRIVE_TOOL_NAMES);
      expect(messages.every((message) => message.jsonrpc === '2.0')).toBe(true);
      expect(stdout).toBe('');
      expect(stderr).toContain('@enterpret/google-drive-mcp: starting stdio server');
      expect(stderr).not.toContain('CLI_DISCOVERY_BEARER');
    } finally {
      child.kill('SIGKILL');
    }
  });
});
