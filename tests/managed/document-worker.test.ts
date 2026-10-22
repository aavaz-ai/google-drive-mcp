import { EventEmitter } from "node:events";
import type { WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn>; options: WorkerOptions }> }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    stdout = { resume: vi.fn() };
    stderr = { resume: vi.fn() };
    terminate = vi.fn(async () => 0);
    constructor(readonly url: URL, readonly options: WorkerOptions) {
      super();
      state.workers.push(this);
    }
  },
}));

import { extractDocumentText } from "../../src/managedFileExtraction.js";

afterEach(() => {
  vi.useRealTimers();
  state.workers.length = 0;
});

describe("document worker containment", () => {
  it("terminates a stalled parser at the deadline and releases the worker slot", async () => {
    vi.useFakeTimers();
    const pending = extractDocumentText(Buffer.from("%PDF"), "application/pdf");
    const failure = expect(pending).rejects.toMatchObject({ code: "DOCUMENT_EXTRACTION_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30_000);
    await failure;
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
    expect(state.workers[0].options).toMatchObject({ env: {}, execArgv: [], stdout: true, stderr: true, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const next = extractDocumentText(Buffer.from("%PDF"), "application/pdf");
    state.workers[1].emit("message", { text: "Recovered text" });
    expect(await next).toBe("Recovered text");
    expect(state.workers[1].terminate).toHaveBeenCalledOnce();
  });

  it("bounds concurrent parser workers", async () => {
    const first = extractDocumentText(Buffer.from("%PDF"), "application/pdf");
    const second = extractDocumentText(Buffer.from("%PDF"), "application/pdf");
    await expect(extractDocumentText(Buffer.from("%PDF"), "application/pdf")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(state.workers).toHaveLength(2);
    state.workers.forEach((worker) => worker.emit("message", { text: "Complete text" }));
    expect(await first).toBe("Complete text");
    expect(await second).toBe("Complete text");
  });

  it.each([null, { text: "" }, { text: "x".repeat(100_001) }, { text: "a\0b" }, { error: "private diagnostic" }])("rejects malformed parser results %#", async (message) => {
    const pending = extractDocumentText(Buffer.from("%PDF"), "application/pdf");
    state.workers[0].emit("message", message);
    await expect(pending).rejects.toMatchObject({ code: "DOCUMENT_EXTRACTION_FAILED" });
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
  });

  it.each(["error", "exit"])("sanitizes worker %s events", async (event) => {
    const pending = extractDocumentText(Buffer.from("%PDF"), "application/pdf");
    state.workers[0].emit(event, event === "error" ? new Error("private document content") : 1);
    await expect(pending).rejects.toMatchObject({ code: "DOCUMENT_EXTRACTION_FAILED", message: "DOCUMENT_EXTRACTION_FAILED" });
    expect(state.workers[0].terminate).toHaveBeenCalledOnce();
  });
});
