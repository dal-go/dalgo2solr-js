import {
  AlreadyExistsError,
  Key,
  NotFoundError,
  UnsupportedError,
  identityCodec,
  type Codec,
  type Database,
  type ExistingRecord,
  type QueryPage,
  type ReadwriteTransaction,
  type RecordSnapshot,
  type StructuredQuery,
  type UpdateData,
  type WriteSession,
} from "@dal-go/dalgo";
import { compileSolrQuery, validateSolrField } from "./query.js";

export type SolrFetch = typeof globalThis.fetch;
export type SolrHeaders = Readonly<Record<string, string>>;

export interface SolrDatabaseOptions {
  /** Solr's context root, for example https://solr.example/solr. */
  readonly baseUrl: string;
  /** The collection schema's unique-key field. Defaults to `id`. */
  readonly idField?: string;
  /** Headers are resolved for each request so a broker can rotate tokens. */
  readonly headers?: SolrHeaders | (() => SolrHeaders | Promise<SolrHeaders>);
  readonly fetch?: SolrFetch;
  /** Per-request deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Maximum number of records a DALgo query may request. Defaults to 1,000. */
  readonly maxQueryLimit?: number;
  /** Maximum response payload accepted before JSON parsing. Defaults to 1 MiB. */
  readonly responseMaxBytes?: number;
  /** Optional Solr commitWithin value for write visibility. */
  readonly commitWithinMs?: number;
}

interface SolrDocument extends Record<string, unknown> {
  readonly _version_?: number | string;
}

interface SolrResponse {
  readonly status: number;
  readonly body: unknown;
}

function codecOrIdentity<T>(codec?: Codec<T>): Codec<T> {
  return (codec ?? identityCodec) as Codec<T>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimeout(value: number | undefined, name: string, defaultValue?: number): number {
  const resolved = value ?? defaultValue;
  if (resolved === undefined || !Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function validateTopLevelKey(key: Key): void {
  if (key.parent !== undefined) throw new UnsupportedError("Solr nested collection keys");
}

function keyId(value: unknown, idField: string): string | number {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new TypeError(`malformed Solr document ${idField} field`);
}

function metadata(document: SolrDocument): Readonly<Record<string, unknown>> | undefined {
  return document._version_ === undefined ? undefined : { version: document._version_ };
}

function dataFromDocument(document: SolrDocument, idField: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(document).filter(([field]) => field !== idField && field !== "_version_"),
  );
}

function documentFrom(value: unknown, context: string): SolrDocument {
  if (!isObject(value)) throw new TypeError(`malformed Solr ${context} document`);
  if (value._version_ !== undefined && typeof value._version_ !== "number" && typeof value._version_ !== "string") {
    throw new TypeError(`malformed Solr ${context} document version`);
  }
  return value;
}

function assertJsonSafe(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must not contain a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`${path} must be JSON-safe`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain a cycle`);
  if (Array.isArray(value)) {
    ancestors.add(value);
    value.forEach((item, index) => {
      assertJsonSafe(item, `${path}[${String(index)}]`, ancestors);
    });
    ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must contain only JSON objects and arrays`);
  }
  ancestors.add(value);
  for (const [name, item] of Object.entries(value)) {
    assertJsonSafe(item, `${path}.${name}`, ancestors);
  }
  ancestors.delete(value);
}

function validateSuccessEnvelope(value: unknown): void {
  if (!isObject(value)) return;
  const header = value.responseHeader;
  if (header !== undefined) {
    if (!isObject(header) || header.status !== undefined && (typeof header.status !== "number" || header.status !== 0)) {
      throw new TypeError("Solr response reports a non-zero or malformed status");
    }
    if (header.partialResults === true) throw new UnsupportedError("Solr partial results");
  }
  if (value.partialResults === true) throw new UnsupportedError("Solr partial results");
}

async function responseText(response: Response, maximumBytes: number): Promise<string> {
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength !== null && /^[0-9]+$/u.test(advertisedLength) && Number(advertisedLength) > maximumBytes) {
    throw new SolrResponseSizeError("Solr response exceeds configured responseMaxBytes");
  }
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new SolrResponseSizeError("Solr response exceeds configured responseMaxBytes");
      }
      text += decoder.decode(chunk.value, { stream: true });
      chunk = await reader.read();
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function responseDocument(value: unknown, idField: string): SolrDocument | undefined {
  if (!isObject(value)) throw new TypeError("malformed Solr realtime-get response");
  if (value.doc === undefined || value.doc === null) return undefined;
  const document = documentFrom(value.doc, "realtime-get");
  keyId(document[idField], idField);
  return document;
}

function queryDocuments(value: unknown, idField: string): readonly SolrDocument[] {
  if (!isObject(value) || !isObject(value.response) || !Array.isArray(value.response.docs)) {
    throw new TypeError("malformed Solr query response");
  }
  return value.response.docs.map((item) => {
    const document = documentFrom(item, "query");
    keyId(document[idField], idField);
    return document;
  });
}

function validateHeaderMap(headers: SolrHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)
      || typeof value !== "string"
      || /[\r\n]/u.test(value)
    ) {
      throw new TypeError("invalid Solr request header");
    }
    result[name] = value;
  }
  return result;
}

function encodedDocument<T>(key: Key, data: T, codec: Codec<T> | undefined, idField: string): Record<string, unknown> {
  validateTopLevelKey(key);
  const encoded = codecOrIdentity(codec).encode(data);
  if (!isObject(encoded)) throw new TypeError("Solr documents must encode to a JSON object");
  if (Object.hasOwn(encoded, idField) || Object.hasOwn(encoded, "_version_")) {
    throw new TypeError(`Solr adapter reserves ${idField} and _version_ document fields`);
  }
  const document = { ...encoded, [idField]: String(key.id) };
  assertJsonSafe(document, "Solr document");
  return document;
}

function atomicUpdateDocument(key: Key, data: UpdateData, idField: string): Record<string, unknown> {
  validateTopLevelKey(key);
  const entries = Object.entries(data);
  if (entries.length === 0) throw new TypeError("Solr updates require at least one field");
  const fields: Record<string, unknown> = {};
  for (const [field, value] of entries) {
    validateSolrField(field);
    if (field === idField || field === "_version_") {
      throw new TypeError(`Solr adapter reserves ${idField} and _version_ update fields`);
    }
    if (value === null) throw new UnsupportedError("Solr atomic update null values; field removal is not a DALgo update operation");
    assertJsonSafe(value, `Solr update ${field}`);
    fields[field] = { set: value };
  }
  return { [idField]: String(key.id), _version_: 1, ...fields };
}

export class SolrHttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.name = "SolrHttpError";
    this.status = status;
  }
}

export class SolrResponseSizeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SolrResponseSizeError";
  }
}

/**
 * DALgo adapter for Solr's JSON Request and JSON Update APIs.
 *
 * Solr update acknowledgement, realtime-get visibility, and search visibility
 * are distinct. Configure Solr auto-commit or commitWithinMs for search.
 */
export class SolrDatabase implements Database, WriteSession {
  readonly #baseUrl: string;
  readonly #idField: string;
  readonly #headers: SolrDatabaseOptions["headers"];
  readonly #fetch: SolrFetch;
  readonly #timeoutMs: number;
  readonly #maxQueryLimit: number;
  readonly #responseMaxBytes: number;
  readonly #commitWithinMs: number | undefined;

  public constructor(options: SolrDatabaseOptions) {
    const url = new URL(options.baseUrl.trim());
    const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
      throw new TypeError("baseUrl must use HTTPS, except for loopback development");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new TypeError("baseUrl must not contain credentials");
    }
    if (url.search.length > 0 || url.hash.length > 0) {
      throw new TypeError("baseUrl must not contain a query or fragment");
    }
    this.#baseUrl = url.toString().replace(/\/+$/u, "");
    this.#idField = options.idField ?? "id";
    validateSolrField(this.#idField);
    if (this.#idField === "_version_") throw new TypeError("idField cannot be _version_");
    this.#headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = validTimeout(options.timeoutMs, "timeoutMs", 30_000);
    this.#maxQueryLimit = validTimeout(options.maxQueryLimit, "maxQueryLimit", 1_000);
    this.#responseMaxBytes = validTimeout(options.responseMaxBytes, "responseMaxBytes", 1_048_576);
    this.#commitWithinMs = options.commitWithinMs === undefined
      ? undefined
      : validTimeout(options.commitWithinMs, "commitWithinMs");
  }

  public async get<T>(key: Key, codec?: Codec<T>): Promise<RecordSnapshot<T>> {
    validateTopLevelKey(key);
    const params = new URLSearchParams({ id: String(key.id), wt: "json" });
    const response = await this.request("GET", this.collectionPath(key.collection, `get?${params.toString()}`));
    const document = responseDocument(response.body, this.#idField);
    if (document === undefined) return { key, exists: false };
    if (String(document[this.#idField]) !== String(key.id)) {
      throw new TypeError("Solr realtime-get response returned an unexpected id");
    }
    const decoded = codecOrIdentity(codec).decode(dataFromDocument(document, this.#idField));
    const documentMetadata = metadata(document);
    const record: ExistingRecord<T> = {
      key,
      exists: true,
      data: decoded,
      ...(documentMetadata === undefined ? {} : { metadata: documentMetadata }),
    };
    return record;
  }

  public getMany<T>(keys: readonly Key[], codec?: Codec<T>): Promise<readonly RecordSnapshot<T>[]> {
    return Promise.all(keys.map(async (key) => this.get(key, codec)));
  }

  public async query<T>(query: StructuredQuery<T>): Promise<QueryPage<T>> {
    const compiled = compileSolrQuery(query, this.#idField, this.#maxQueryLimit);
    const response = await this.request("POST", this.collectionPath(query.source.name, "query"), compiled.body);
    const records = queryDocuments(response.body, this.#idField).map((document): ExistingRecord<T> => {
      const id = keyId(document[this.#idField], this.#idField);
      const documentMetadata = metadata(document);
      return {
        key: new Key(query.source.name, id),
        exists: true,
        data: codecOrIdentity(query.source.codec).decode(dataFromDocument(document, this.#idField)),
        ...(documentMetadata === undefined ? {} : { metadata: documentMetadata }),
      };
    });
    return { records };
  }

  public async insert<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    const document = { ...encodedDocument(key, data, codec, this.#idField), _version_: -1 };
    const response = await this.request("POST", this.updatePath(key.collection), [document], [409]);
    if (response.status === 409) {
      throw new AlreadyExistsError(key, { cause: new SolrHttpError(409, "Solr document already exists") });
    }
  }

  public async set<T>(key: Key, data: T, codec?: Codec<T>): Promise<void> {
    await this.request("POST", this.updatePath(key.collection), [encodedDocument(key, data, codec, this.#idField)]);
  }

  public async update(key: Key, data: UpdateData): Promise<void> {
    const response = await this.request(
      "POST",
      this.updatePath(key.collection),
      [atomicUpdateDocument(key, data, this.#idField)],
      [409],
    );
    if (response.status === 409) {
      throw new NotFoundError(key, { cause: new SolrHttpError(409, "Solr document does not exist") });
    }
  }

  public async delete(key: Key): Promise<void> {
    validateTopLevelKey(key);
    await this.request("POST", this.updatePath(key.collection), { delete: String(key.id) });
  }

  public runReadwriteTransaction<Result>(
    callback: (transaction: ReadwriteTransaction) => Promise<Result>,
  ): Promise<Result> {
    if (typeof callback !== "function") throw new TypeError("transaction callback is required");
    return Promise.reject(new UnsupportedError("Solr multi-document transactions"));
  }

  private collectionPath(collection: string, suffix: string): string {
    return `/${encodeURIComponent(collection)}/${suffix}`;
  }

  private updatePath(collection: string): string {
    const commit = this.#commitWithinMs === undefined ? "" : `?commitWithin=${String(this.#commitWithinMs)}`;
    return this.collectionPath(collection, `update${commit}`);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    acceptedStatuses: readonly number[] = [],
  ): Promise<SolrResponse> {
    const configured = typeof this.#headers === "function" ? await this.#headers() : (this.#headers ?? {});
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(this.#timeoutMs),
      headers: {
        ...validateHeaderMap(configured),
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await responseText(response, this.#responseMaxBytes);
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      throw new SolrHttpError(response.status, `Solr request failed with HTTP ${String(response.status)}`);
    }
    if (response.ok) validateSuccessEnvelope(parsed);
    return { status: response.status, body: parsed };
  }
}
