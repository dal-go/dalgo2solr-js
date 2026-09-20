import { AlreadyExistsError, NotFoundError, UnsupportedError, collection, key } from "@dal-go/dalgo";
import { describe, expect, it, vi } from "vitest";
import { SolrDatabase, SolrHttpError, SolrResponseSizeError } from "../src/index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("SolrDatabase", () => {
  it("uses realtime get, strips reserved fields, and refreshes headers", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ doc: { id: "a/b", title: "one", _version_: 4 } }))
      .mockResolvedValueOnce(json({ responseHeader: { status: 0 } }));
    const headers = vi.fn().mockReturnValue({ Authorization: "Bearer secret" });
    const db = new SolrDatabase({ baseUrl: "https://solr.example/solr/", fetch, headers });

    await expect(db.get(key("items", "a/b"))).resolves.toEqual({
      key: key("items", "a/b"),
      exists: true,
      data: { title: "one" },
      metadata: { version: 4 },
    });
    await db.delete(key("items", "a/b"));

    expect(fetch.mock.calls[0]?.[0]).toBe("https://solr.example/solr/items/get?id=a%2Fb&wt=json");
    expect(headers).toHaveBeenCalledTimes(2);
  });

  it("returns a missing record when realtime get has no doc and preserves getMany order", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ responseHeader: { status: 0 } }))
      .mockResolvedValueOnce(json({ doc: { id: "2", value: 2 } }));
    const db = new SolrDatabase({ baseUrl: "https://solr.example/solr", fetch });
    const records = await db.getMany([key("items", "1"), key("items", "2")]);
    expect(records).toEqual([
      { key: key("items", "1"), exists: false },
      { key: key("items", "2"), exists: true, data: { value: 2 } },
    ]);
  });

  it("decodes query documents, maps ids, and does not fabricate a cursor", async () => {
    const fetch = vi.fn().mockResolvedValue(json({ response: { docs: [
      { id: "p1", price: 12, _version_: 7 },
    ] } }));
    const db = new SolrDatabase({ baseUrl: "https://solr.example/solr", fetch });
    const result = await db.query(collection<{ price: number }>("products").query().orderBy("price").limit(1).build());
    expect(result).toEqual({ records: [{
      key: key("products", "p1"), exists: true, data: { price: 12 }, metadata: { version: 7 },
    }] });
    const request = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(request?.body as string)).toEqual({ query: "*:*", sort: "price asc", limit: 1 });
    expect(result.nextCursor).toBeUndefined();
  });

  it("uses Solr conditional insert and existence-only atomic update", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ responseHeader: { status: 0 } }))
      .mockResolvedValueOnce(json({ responseHeader: { status: 0 } }))
      .mockResolvedValueOnce(json({ responseHeader: { status: 0 } }));
    const db = new SolrDatabase({ baseUrl: "https://solr.example/solr", fetch, commitWithinMs: 500 });
    const item = key("items", "1");
    await db.insert(item, { name: "first" });
    await db.update(item, { name: "updated" });
    await db.delete(item);

    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => [url, init.method])).toEqual([
      ["https://solr.example/solr/items/update?commitWithin=500", "POST"],
      ["https://solr.example/solr/items/update?commitWithin=500", "POST"],
      ["https://solr.example/solr/items/update?commitWithin=500", "POST"],
    ]);
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual([{ id: "1", name: "first", _version_: -1 }]);
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual([{ id: "1", _version_: 1, name: { set: "updated" } }]);
    expect(JSON.parse(calls[2]?.[1].body as string)).toEqual({ delete: "1" });
    expect(calls[0]?.[1].redirect).toBe("error");
    expect(calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("maps Solr conditional failures without inventing a transaction", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ error: { msg: "version conflict" } }, 409))
      .mockResolvedValueOnce(json({ error: { msg: "not found" } }, 409));
    const db = new SolrDatabase({ baseUrl: "https://solr.example/solr", fetch });
    await expect(db.insert(key("items", "1"), { n: 1 })).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(db.update(key("items", "1"), { n: 1 })).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.runReadwriteTransaction(() => Promise.resolve("never"))).rejects.toBeInstanceOf(UnsupportedError);
  });

  it("rejects unsafe configuration and reserved or malformed documents before requesting", async () => {
    expect(() => new SolrDatabase({ baseUrl: "http://solr.example/solr" })).toThrow("HTTPS");
    expect(() => new SolrDatabase({ baseUrl: "https://user:secret@solr.example/solr" })).toThrow("credentials");
    expect(() => new SolrDatabase({ baseUrl: "https://solr.example/solr?secret=value" })).toThrow("query or fragment");
    expect(() => new SolrDatabase({ baseUrl: "https://solr.example/solr", idField: "bad field" })).toThrow("unsafe");
    expect(() => new SolrDatabase({ baseUrl: "https://solr.example/solr", commitWithinMs: 0 })).toThrow("positive");
    expect(() => new SolrDatabase({ baseUrl: "https://solr.example/solr", maxQueryLimit: 0 })).toThrow("positive");

    const fetch = vi.fn();
    const db = new SolrDatabase({ baseUrl: "http://localhost:8983/solr", fetch });
    await expect(db.set(key("items", "1"), { id: "overridden" })).rejects.toThrow("reserves");
    await expect(db.set(key("items", "1"), { value: undefined })).rejects.toThrow("JSON-safe");
    await expect(db.update(key("items", "1"), {})).rejects.toThrow("at least one");
    await expect(db.update(key("items", "1"), { value: null })).rejects.toBeInstanceOf(UnsupportedError);
    await expect(db.get(key("items", "1", key("parents", "p1")))).rejects.toBeInstanceOf(UnsupportedError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed payloads and does not retain reflected secrets in errors", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ doc: { id: null } }))
      .mockResolvedValueOnce(json({ response: { docs: "not-an-array" } }))
      .mockResolvedValueOnce(json({ error: "reflected-token-secret" }, 401));
    const db = new SolrDatabase({
      baseUrl: "https://solr.example/solr",
      fetch,
      headers: { Authorization: "Bearer secret" },
    });
    await expect(db.get(key("items", "1"))).rejects.toThrow("malformed Solr document id");
    await expect(db.query(collection("items").query().build())).rejects.toThrow("malformed Solr query response");
    const error = await db.get(key("items", "1")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SolrHttpError);
    expect(String(error)).not.toContain("secret");
    expect(error).not.toHaveProperty("body");
  });

  it("enforces default and configured query caps and rejects partial or oversized responses", async () => {
    let streamCancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("four"));
        controller.enqueue(new TextEncoder().encode("-more"));
      },
      cancel() {
        streamCancelled = true;
      },
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ response: { docs: [] } }))
      .mockResolvedValueOnce(json({ responseHeader: { status: 0, partialResults: true }, response: { docs: [] } }))
      .mockResolvedValueOnce(new Response(oversizedStream));
    const db = new SolrDatabase({ baseUrl: "https://solr.example/solr", fetch, maxQueryLimit: 7 });
    await db.query(collection("items").query().build());
    const request = fetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(request?.body as string)).toEqual({ query: "*:*", limit: 7 });
    await expect(db.query(collection("items").query().build())).rejects.toBeInstanceOf(UnsupportedError);
    const smallResponseDb = new SolrDatabase({ baseUrl: "https://solr.example/solr", fetch, responseMaxBytes: 4 });
    await expect(smallResponseDb.get(key("items", "1"))).rejects.toBeInstanceOf(SolrResponseSizeError);
    expect(streamCancelled).toBe(true);
    const advertisedDb = new SolrDatabase({
      baseUrl: "https://solr.example/solr",
      responseMaxBytes: 4,
      fetch: vi.fn().mockResolvedValue(new Response("{}", { headers: { "content-length": "5" } })),
    });
    await expect(advertisedDb.get(key("items", "1"))).rejects.toBeInstanceOf(SolrResponseSizeError);
    await expect(db.query(collection("items").query().limit(8).build())).rejects.toThrow("maxQueryLimit");
  });
});
