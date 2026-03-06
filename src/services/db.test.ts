import { describe, it, expect, vi, beforeEach } from "vitest";
import { dbGetThreads, dbMarkThreadFlushed } from "./db";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("Thread flushedAt roundtrip and dbMarkThreadFlushed", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("maps flushedAt from Rust (camelCase) to Thread", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: "t1",
        bookId: "b1",
        title: "Discussion",
        createdAt: 1000,
        updatedAt: 2000,
        archived: 0,
        flushedAt: 999,
      },
    ]);
    const threads = await dbGetThreads("b1");
    expect(threads).toHaveLength(1);
    expect(threads[0].flushedAt).toBe(999);
    expect(threads[0].archived).toBe(false);
  });

  it("maps null flushedAt when not set", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        id: "t2",
        bookId: "b1",
        title: "New thread",
        createdAt: 1000,
        updatedAt: 1000,
        archived: 0,
        flushedAt: null,
      },
    ]);
    const threads = await dbGetThreads("b1");
    expect(threads[0].flushedAt).toBeNull();
  });

  it("dbMarkThreadFlushed invokes with id and flushedAt", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await dbMarkThreadFlushed("thread-123", 12345);
    expect(invoke).toHaveBeenCalledWith("db_mark_thread_flushed", {
      id: "thread-123",
      flushedAt: 12345,
    });
  });

  it("dbMarkThreadFlushed uses Date.now() when flushedAt omitted", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const before = Date.now();
    await dbMarkThreadFlushed("thread-456");
    const after = Date.now();
    expect(invoke).toHaveBeenCalledWith("db_mark_thread_flushed", expect.any(Object));
    const args = vi.mocked(invoke).mock.calls[0][1] as { id: string; flushedAt: number };
    expect(args.id).toBe("thread-456");
    expect(typeof args.flushedAt).toBe("number");
    expect(args.flushedAt).toBeGreaterThanOrEqual(before);
    expect(args.flushedAt).toBeLessThanOrEqual(after + 10);
  });
});
