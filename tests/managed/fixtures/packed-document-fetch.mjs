// Synthetic provider boundary used only by the packed-artifact smoke test.
const fixtures = JSON.parse(process.env.DRIVE_PACKED_DOCUMENT_FIXTURES ?? "{}");
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (process.env.GOOGLE_DRIVE_OAUTH_BEARER !== "PACKED_ARTIFACT_DISCOVERY_ONLY" ||
      url.origin !== "https://www.googleapis.com" || (init?.method ?? "GET") !== "GET") {
    throw new Error("Unexpected request in packed document smoke");
  }
  if (url.pathname === "/drive/v3/files") return Response.json({ files: [] });
  const id = url.pathname.split("/").at(-1);
  const fixture = fixtures[id];
  if (!fixture) return Response.json({}, { status: 404 });
  if (url.searchParams.get("alt") === "media") return new Response(Buffer.from(fixture.base64, "base64"));
  return Response.json({ id, name: id, mimeType: fixture.mime, parents: [], trashed: false, capabilities: { canDownload: true } });
};
