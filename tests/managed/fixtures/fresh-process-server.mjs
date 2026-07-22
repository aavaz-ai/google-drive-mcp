const expectedBearer = "REFRESHED_MOCK_BEARER";

function selectedItem() {
  return {
    id: "picked_after_refresh",
    name: "Picked after refresh.txt",
    mimeType: "text/plain",
    parents: [],
    webViewLink: "https://drive.google.com/open?id=picked_after_refresh",
    createdTime: "2026-07-01T00:00:00.000Z",
    modifiedTime: "2026-07-01T00:00:00.000Z",
    trashed: false,
    capabilities: {
      canEdit: true,
      canCopy: true,
      canAddChildren: false,
      canDownload: true,
      canRename: true,
      canTrash: true,
      canUntrash: true,
      canModifyContent: true,
      canMoveItemWithinDrive: true,
      canMoveItemOutOfDrive: true,
      canShare: true,
    },
  };
}

globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (new Headers(init?.headers).get("authorization") !== `Bearer ${expectedBearer}`) {
    return Response.json({}, { status: 401 });
  }
  if (url.pathname === "/drive/v3/files") return Response.json({ files: [] });
  if (url.pathname.endsWith("/picked_after_refresh")) {
    if (url.searchParams.get("alt") === "media") return new Response("fresh process content");
    return Response.json(selectedItem());
  }
  if (url.pathname.endsWith("/unpicked_after_refresh")) {
    return Response.json({ provider_body: "must-not-surface" }, { status: 404 });
  }
  throw new Error(`unexpected mocked provider request: ${url.pathname}`);
};

await import("../../../dist/index.js");
