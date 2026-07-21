import { describe, expect, it } from 'vitest';

import type { GoogleDriveMcpError } from '../../src/managedErrors.js';
import {
  GoogleDriveClient,
  WORKSPACE_DESCRIPTION,
  type FetchLike,
} from '../../src/managedWorkspace.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const PRESENTATION_MIME = 'application/vnd.google-apps.presentation';

function driveFile(id: string, name: string, parents: string[] = [], mimeType = FOLDER_MIME, trashed = false) {
  return {
    id,
    name,
    mimeType,
    parents,
    webViewLink: `https://drive.google.com/open?id=${id}`,
    createdTime: '2026-07-01T00:00:00.000Z',
    modifiedTime: '2026-07-01T00:00:00.000Z',
    trashed,
    description: name === 'Enterpret' ? WORKSPACE_DESCRIPTION : undefined,
  };
}

function parts(input: string | URL | Request, init?: RequestInit) {
  return { url: new URL(String(input)), method: init?.method ?? 'GET' };
}

function routedFetcher(
  files: Map<string, ReturnType<typeof driveFile>>,
  onWrite: (url: URL, method: string, init?: RequestInit) => Response,
  onRead?: (url: URL) => Response | undefined,
): FetchLike {
  const workspace = files.get('workspace_id');
  if (workspace === undefined) throw new Error('workspace fixture is required');
  return async (input, init) => {
    const { url, method } = parts(input, init);
    if (method !== 'GET') return onWrite(url, method, init);
    const custom = onRead?.(url);
    if (custom !== undefined) return custom;
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/files') {
      return Response.json({ files: [workspace] });
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/drive/v3/files/')) {
      const id = url.pathname.split('/').at(-1) ?? '';
      const file = files.get(id);
      return file === undefined ? Response.json({}, { status: 404 }) : Response.json(file);
    }
    throw new Error(`unexpected read ${url}`);
  };
}

describe('managed safety regressions', () => {
  it('rejects sharing and permission removal on the workspace root before provider writes', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    let permissionCalls = 0;
    const client = new GoogleDriveClient('bearer', {
      fetch: routedFetcher(
        new Map([[workspace.id, workspace]]),
        () => {
          permissionCalls += 1;
          return Response.json({});
        },
        (url) => {
          if (url.pathname.includes('/permissions/')) permissionCalls += 1;
          return undefined;
        },
      ),
    });

    await expect(client.shareItem({
      item_id: workspace.id,
      recipient_type: 'user',
      email: 'person@example.com',
      role: 'reader',
      send_notification: true,
    })).rejects.toMatchObject({ code: 'outside_workspace' });
    await expect(client.removeItemPermission({
      item_id: workspace.id,
      permission_id: 'permission_id',
    })).rejects.toMatchObject({ code: 'outside_workspace' });
    expect(permissionCalls).toBe(0);
  });

  it('omits orderBy only for full-text search and retains deterministic ordering elsewhere', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const urls: URL[] = [];
    const client = new GoogleDriveClient('bearer', {
      fetch: async (input) => {
        const url = new URL(String(input));
        urls.push(url);
        if (url.pathname === '/drive/v3/files' && url.searchParams.get('q')?.includes('fullText')) {
          return Response.json({ files: [] });
        }
        if (url.pathname === '/drive/v3/files') return Response.json({ files: [workspace] });
        if (url.pathname.endsWith('/workspace_id')) return Response.json(workspace);
        throw new Error(`unexpected ${url}`);
      },
    });

    await client.searchWorkspaceItems({ query: 'quarterly', page_size: 50 });
    await client.listWorkspaceItems({ page_size: 50 });

    const fullTextRequest = urls.find((url) => url.searchParams.get('q')?.includes('fullText'));
    const workspaceRequests = urls.filter((url) => url.searchParams.get('q')?.includes("name = 'Enterpret'"));
    const folderRequest = urls.find((url) => url.searchParams.get('q')?.includes("'workspace_id' in parents"));
    expect(fullTextRequest?.searchParams.has('orderBy')).toBe(false);
    expect(workspaceRequests.length).toBeGreaterThan(0);
    expect(workspaceRequests.every((url) => url.searchParams.get('orderBy') === 'createdTime asc,name_natural')).toBe(true);
    expect(folderRequest?.searchParams.get('orderBy')).toBe('createdTime asc,name_natural');
  });

  it('fails closed when folder-cycle ancestry traversal exhausts its budget', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const source = driveFile('source_folder', 'Source', [workspace.id]);
    const files = new Map<string, ReturnType<typeof driveFile>>([
      [workspace.id, workspace],
      [source.id, source],
    ]);
    let previous = source.id;
    for (let index = 0; index < 260; index += 1) {
      const id = `chain_${String(index)}`;
      files.set(id, driveFile(id, id, [previous]));
      previous = id;
    }
    const destination = driveFile('destination', 'Destination', [workspace.id, previous]);
    files.set(destination.id, destination);
    let writes = 0;
    const client = new GoogleDriveClient('bearer', {
      fetch: routedFetcher(files, () => {
        writes += 1;
        return Response.json({});
      }),
    });

    await expect(client.moveItem(source.id, destination.id)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(writes).toBe(0);
  });

  it('fails closed when workspace discovery exceeds the internal page bound', async () => {
    let calls = 0;
    let writes = 0;
    const client = new GoogleDriveClient('bearer', {
      fetch: async (_input, init) => {
        if ((init?.method ?? 'GET') !== 'GET') writes += 1;
        calls += 1;
        return Response.json({ files: [], nextPageToken: `page_${String(calls)}` });
      },
    });

    await expect(client.ensureWorkspace()).rejects.toMatchObject({ code: 'provider_invalid_response' });
    expect(calls).toBe(10);
    expect(writes).toBe(0);
  });

  it('rejects declared oversized read responses and makes oversized write acknowledgements ambiguous', async () => {
    const oversizedHeaders = { 'content-length': String(9 * 1024 * 1024) };
    const readClient = new GoogleDriveClient('bearer', {
      fetch: async () => new Response('{}', { status: 200, headers: oversizedHeaders }),
    });
    await expect(readClient.ensureWorkspace()).rejects.toMatchObject({
      code: 'provider_invalid_response',
      outcome: 'not_completed',
    });

    const workspace = driveFile('workspace_id', 'Enterpret');
    let writes = 0;
    const writeClient = new GoogleDriveClient('bearer', {
      fetch: routedFetcher(new Map([[workspace.id, workspace]]), () => {
        writes += 1;
        return new Response('{}', { status: 200, headers: oversizedHeaders });
      }),
    });
    await expect(writeClient.createFolder({ name: 'Folder', parent_id: undefined })).rejects.toMatchObject({
      code: 'write_unknown_outcome',
      outcome: 'unknown',
    });
    expect(writes).toBe(1);
  });

  it('retries transient response-stream failures only for reads', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const sleeps: number[] = [];
    let calls = 0;
    const client = new GoogleDriveClient('bearer', {
      fetch: async () => {
        calls += 1;
        if (calls < 3) {
          return new Response(new ReadableStream({
            start(controller) {
              controller.error(new Error('provider body marker'));
            },
          }), { status: 200 });
        }
        return Response.json({ files: [workspace] });
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(client.ensureWorkspace()).resolves.toMatchObject({ status: 'found' });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 300]);
  });

  it('uses a provider byte range and keeps text continuation offsets round-trippable', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const item = driveFile('text_id', 'text.txt', [workspace.id], 'text/plain');
    const text = 'x'.repeat(100_000);
    const ranges: string[] = [];
    const client = new GoogleDriveClient('bearer', {
      fetch: async (input, init) => {
        const { url, method } = parts(input, init);
        if (method === 'GET' && url.pathname === '/drive/v3/files') return Response.json({ files: [workspace] });
        if (method === 'GET' && url.searchParams.get('alt') === 'media') {
          ranges.push(new Headers(init?.headers).get('range') ?? '');
          return new Response(text, { status: 200 });
        }
        if (method === 'GET' && url.pathname.endsWith('/text_id')) return Response.json(item);
        throw new Error(`unexpected ${method} ${url}`);
      },
    });

    const first = await client.readTextFile({ item_id: item.id, offset: 0, limit: 50_000 });
    expect(first.next_offset).toBe(50_000);
    const second = await client.readTextFile({
      item_id: item.id,
      offset: first.next_offset ?? 0,
      limit: 50_000,
    });
    expect(second.next_offset).toBeNull();
    expect(ranges).toEqual(['bytes=0-399999', 'bytes=0-399999']);
  });

  it('rejects multi-tab Docs for reads and updates before dispatching a write', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const document = driveFile('doc_id', 'Document', [workspace.id], DOC_MIME);
    let writes = 0;
    const client = new GoogleDriveClient('bearer', {
      fetch: routedFetcher(
        new Map([[workspace.id, workspace], [document.id, document]]),
        () => {
          writes += 1;
          return Response.json({});
        },
        (url) => {
          if (url.hostname === 'docs.googleapis.com') {
            expect(url.searchParams.get('includeTabsContent')).toBe('true');
            return Response.json({
              tabs: [{
                documentTab: { body: { content: [] } },
                childTabs: [{ documentTab: { body: { content: [] } } }],
              }],
            });
          }
          return undefined;
        },
      ),
    });

    await expect(client.readGoogleDoc({ document_id: document.id, offset: 0, limit: 10 })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(client.updateGoogleDoc({ document_id: document.id, content: 'replacement' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(writes).toBe(0);
  });

  it('rejects malformed Drive, Docs, and Slides structures before provider writes', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const document = driveFile('doc_id', 'Document', [workspace.id], DOC_MIME);
    const presentation = driveFile('slides_id', 'Slides', [workspace.id], PRESENTATION_MIME);

    const driveClient = new GoogleDriveClient('bearer', {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/drive/v3/files') return Response.json({ files: [workspace] });
        if (url.pathname.endsWith('/malformed_id')) {
          return Response.json({ ...driveFile('malformed_id', 'Malformed'), parents: workspace.id });
        }
        throw new Error(`unexpected ${url}`);
      },
    });
    await expect(driveClient.getItemMetadata('malformed_id')).rejects.toMatchObject({
      code: 'provider_invalid_response',
    });

    let writes = 0;
    const files = new Map([[workspace.id, workspace], [document.id, document], [presentation.id, presentation]]);
    const docsClient = new GoogleDriveClient('bearer', {
      fetch: routedFetcher(
        files,
        () => {
          writes += 1;
          return Response.json({});
        },
        (url) => url.hostname === 'docs.googleapis.com'
          ? Response.json({ tabs: [{ documentTab: { body: { content: 'not-an-array' } } }] })
          : undefined,
      ),
    });
    await expect(docsClient.updateGoogleDoc({ document_id: document.id, content: 'replacement' })).rejects.toMatchObject({
      code: 'provider_invalid_response',
    });

    const slidesClient = new GoogleDriveClient('bearer', {
      fetch: routedFetcher(
        files,
        () => {
          writes += 1;
          return Response.json({});
        },
        (url) => url.hostname === 'slides.googleapis.com' ? Response.json({ slides: [{}] }) : undefined,
      ),
    });
    await expect(slidesClient.updateGooglePresentation({
      presentation_id: presentation.id,
      slides: [{ title: 'Title', body: 'Body' }],
    })).rejects.toMatchObject({ code: 'provider_invalid_response' });
    expect(writes).toBe(0);
  });

  it('classifies incomplete 2xx acknowledgements for every write family as unknown and never retries them', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const text = driveFile('text_id', 'text.txt', [workspace.id], 'text/plain');
    const doc = driveFile('doc_id', 'Doc', [workspace.id], DOC_MIME);
    const sheet = driveFile('sheet_id', 'Sheet', [workspace.id], SHEET_MIME);
    const slides = driveFile('slides_id', 'Slides', [workspace.id], PRESENTATION_MIME);
    const destination = driveFile('destination_id', 'Destination', [workspace.id]);
    const trashed = driveFile('trashed_id', 'Trashed', [workspace.id], 'text/plain', true);
    const files = new Map([
      [workspace.id, workspace],
      [text.id, text],
      [doc.id, doc],
      [sheet.id, sheet],
      [slides.id, slides],
      [destination.id, destination],
      [trashed.id, trashed],
    ]);
    const cases: Array<{ name: string; run: (client: GoogleDriveClient) => Promise<unknown> }> = [
      { name: 'create', run: (client) => client.createFolder({ name: 'New folder', parent_id: undefined }) },
      { name: 'upload', run: (client) => client.replaceTextFile({ item_id: text.id, content: 'replacement' }) },
      { name: 'doc update', run: (client) => client.updateGoogleDoc({ document_id: doc.id, content: 'replacement' }) },
      {
        name: 'sheet update',
        run: (client) => client.updateGoogleSheet({
          spreadsheet_id: sheet.id,
          range: 'A1:B2',
          values: [[1, 2], [3, 4]],
          value_input_option: 'RAW',
        }),
      },
      {
        name: 'slides update',
        run: (client) => client.updateGooglePresentation({
          presentation_id: slides.id,
          slides: [{ title: 'Title', body: 'Body' }],
        }),
      },
      { name: 'rename', run: (client) => client.renameItem({ item_id: text.id, new_name: 'renamed.txt' }) },
      { name: 'move', run: (client) => client.moveItem(text.id, destination.id) },
      {
        name: 'copy',
        run: (client) => client.copyItem({ item_id: text.id, destination_folder_id: destination.id }),
      },
      { name: 'trash', run: (client) => client.trashItem(text.id) },
      { name: 'restore', run: (client) => client.restoreItem(trashed.id) },
      {
        name: 'share',
        run: (client) => client.shareItem({
          item_id: text.id,
          recipient_type: 'user',
          email: 'person@example.com',
          role: 'reader',
          send_notification: true,
        }),
      },
      {
        name: 'permission removal',
        run: (client) => client.removeItemPermission({ item_id: text.id, permission_id: 'permission_id' }),
      },
    ];

    for (const testCase of cases) {
      let writes = 0;
      const client = new GoogleDriveClient('bearer', {
        fetch: routedFetcher(
          files,
          () => {
            writes += 1;
            return Response.json({});
          },
          (url) => {
            if (url.hostname === 'docs.googleapis.com') {
              return Response.json({ body: { content: [{ endIndex: 2 }] } });
            }
            if (url.hostname === 'slides.googleapis.com') return Response.json({ slides: [] });
            if (url.pathname.endsWith('/permissions/permission_id')) {
              return Response.json({
                id: 'permission_id',
                type: 'user',
                role: 'reader',
                emailAddress: 'person@example.com',
              });
            }
            return undefined;
          },
        ),
      });

      await expect(testCase.run(client), testCase.name).rejects.toMatchObject({
        code: 'write_unknown_outcome',
        outcome: 'unknown',
      } satisfies Partial<GoogleDriveMcpError>);
      expect(writes, testCase.name).toBe(1);
    }
  });

  it('accepts documented acknowledgements for update, organization, and permission writes', async () => {
    const workspace = driveFile('workspace_id', 'Enterpret');
    const text = driveFile('text_id', 'text.txt', [workspace.id], 'text/plain');
    const doc = driveFile('doc_id', 'Doc', [workspace.id], DOC_MIME);
    const sheet = driveFile('sheet_id', 'Sheet', [workspace.id], SHEET_MIME);
    const slides = driveFile('slides_id', 'Slides', [workspace.id], PRESENTATION_MIME);
    const destination = driveFile('destination_id', 'Destination', [workspace.id]);
    const trashed = driveFile('trashed_id', 'Trashed', [workspace.id], 'text/plain', true);
    const files = new Map([
      [workspace.id, workspace],
      [text.id, text],
      [doc.id, doc],
      [sheet.id, sheet],
      [slides.id, slides],
      [destination.id, destination],
      [trashed.id, trashed],
    ]);
    const client = new GoogleDriveClient('bearer', {
      fetch: routedFetcher(
        files,
        (url, method, init) => {
          if (url.hostname === 'www.googleapis.com' && url.pathname.startsWith('/upload/drive/v3/files/')) {
            return Response.json(text);
          }
          if (url.hostname === 'docs.googleapis.com') return Response.json({ documentId: doc.id });
          if (url.hostname === 'sheets.googleapis.com') {
            return Response.json({
              spreadsheetId: sheet.id,
              updatedRange: 'Sheet!A1:B2',
              updatedRows: 2,
              updatedColumns: 2,
              updatedCells: 4,
            });
          }
          if (url.hostname === 'slides.googleapis.com') return Response.json({ presentationId: slides.id });
          if (url.pathname.endsWith('/copy')) {
            return Response.json(driveFile('copied_id', text.name, [destination.id], text.mimeType));
          }
          if (url.pathname.endsWith('/permissions') && method === 'POST') {
            return Response.json({
              id: 'permission_id',
              type: 'user',
              role: 'reader',
              emailAddress: 'person@example.com',
            });
          }
          if (url.pathname.endsWith('/permissions/permission_id') && method === 'DELETE') {
            return new Response(null, { status: 204 });
          }
          if (url.searchParams.has('addParents')) {
            return Response.json({ ...text, parents: [destination.id] });
          }
          if (method === 'PATCH' && url.pathname.endsWith('/text_id')) {
            const body = JSON.parse(String(init?.body)) as { name?: string; trashed?: boolean };
            if (body.name !== undefined) return Response.json({ ...text, name: body.name });
            if (body.trashed === true) return Response.json({ ...text, trashed: true });
          }
          if (method === 'PATCH' && url.pathname.endsWith('/trashed_id')) {
            return Response.json({ ...trashed, trashed: false });
          }
          throw new Error('write route must be selected by the caller-specific fixture');
        },
        (url) => {
          if (url.hostname === 'docs.googleapis.com') {
            return Response.json({
              tabs: [{ documentTab: { body: { content: [{ endIndex: 2 }] } } }],
            });
          }
          if (url.hostname === 'slides.googleapis.com') return Response.json({ slides: [] });
          if (url.pathname.endsWith('/permissions/permission_id')) {
            return Response.json({
              id: 'permission_id',
              type: 'user',
              role: 'reader',
              emailAddress: 'person@example.com',
            });
          }
          return undefined;
        },
      ),
    });

    await expect(client.replaceTextFile({ item_id: text.id, content: 'replacement' })).resolves.toMatchObject({
      status: 'updated',
    });
    await expect(client.updateGoogleDoc({ document_id: doc.id, content: 'replacement' })).resolves.toMatchObject({
      status: 'updated',
    });
    await expect(client.updateGoogleSheet({
      spreadsheet_id: sheet.id,
      range: 'A1:B2',
      values: [[1, 2], [3, 4]],
      value_input_option: 'RAW',
    })).resolves.toMatchObject({ status: 'updated' });
    await expect(client.updateGooglePresentation({
      presentation_id: slides.id,
      slides: [{ title: 'Title', body: 'Body' }],
    })).resolves.toMatchObject({ status: 'updated' });
    await expect(client.renameItem({ item_id: text.id, new_name: 'renamed.txt' })).resolves.toMatchObject({
      status: 'renamed',
      item: { name: 'renamed.txt' },
    });
    await expect(client.moveItem(text.id, destination.id)).resolves.toMatchObject({ status: 'moved' });
    await expect(client.copyItem({
      item_id: text.id,
      destination_folder_id: destination.id,
    })).resolves.toMatchObject({ status: 'copied', item: { id: 'copied_id' } });
    await expect(client.trashItem(text.id)).resolves.toMatchObject({ status: 'trashed' });
    await expect(client.restoreItem(trashed.id)).resolves.toMatchObject({ status: 'restored' });
    await expect(client.shareItem({
      item_id: text.id,
      recipient_type: 'user',
      email: 'person@example.com',
      role: 'reader',
      send_notification: true,
    })).resolves.toMatchObject({ status: 'shared', permission: { id: 'permission_id' } });
    await expect(client.removeItemPermission({
      item_id: text.id,
      permission_id: 'permission_id',
    })).resolves.toMatchObject({ status: 'permission_removed' });
  });
});
