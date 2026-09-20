import {
  DOCUMENT_ID,
  Key,
  UnsupportedError,
  type FieldPath,
  type QueryFilter,
  type StructuredQuery,
} from "@dal-go/dalgo";

type JsonObject = Record<string, unknown>;

export interface CompiledSolrQuery {
  readonly body: JsonObject;
}

/** A Solr field used by the adapter must be an ordinary schema/dynamic-field name. */
export function validateSolrField(field: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(field)) {
    throw new TypeError(`unsafe Solr field name: ${field}`);
  }
}

function fieldName<T>(field: FieldPath<T>, idField: string): string {
  const name = field === DOCUMENT_ID ? idField : String(field);
  validateSolrField(name);
  return name;
}

function primitive(value: unknown, operator: string): string | number | boolean {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new UnsupportedError(`Solr ${operator} filters require a string, finite number, or boolean`);
}

function rangeValue(value: unknown, operator: string): string | number {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new UnsupportedError(`Solr ${operator} filters require a string or finite number`);
}

function fieldClause(field: string, value: unknown, operator: string): JsonObject {
  return { field: { f: field, query: primitive(value, operator) } };
}

function rangeClause(field: string, value: unknown, operator: "<" | "<=" | ">" | ">="): JsonObject {
  const bound = rangeValue(value, operator);
  switch (operator) {
    case "<":
      return { frange: { u: bound, incu: false, query: field } };
    case "<=":
      return { frange: { u: bound, query: field } };
    case ">":
      return { frange: { l: bound, incl: false, query: field } };
    case ">=":
      return { frange: { l: bound, query: field } };
  }
}

function documentIdValue(value: unknown, collection: string): unknown {
  if (!(value instanceof Key)) return value;
  if (value.parent !== undefined || value.collection !== collection) {
    throw new TypeError(`Solr document key belongs to ${value.collectionPath}, expected ${collection}`);
  }
  return value.id;
}

function filterClause<T>(filter: QueryFilter<T>, idField: string, collection: string): JsonObject {
  const field = fieldName(filter.field, idField);
  const value = filter.field === DOCUMENT_ID ? documentIdValue(filter.value, collection) : filter.value;
  switch (filter.operator) {
    case "==":
      return fieldClause(field, value, "==");
    case "in": {
      if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError("Solr in filters require a non-empty array");
      }
      return {
        bool: {
          should: value.map((item) => fieldClause(
            field,
            filter.field === DOCUMENT_ID ? documentIdValue(item, collection) : item,
            "in",
          )),
        },
      };
    }
    case "<":
    case "<=":
    case ">":
    case ">=":
      return rangeClause(field, value, filter.operator);
    case "!=":
    case "not-in":
    case "array-contains":
    case "array-contains-any":
      throw new UnsupportedError(`Solr filter operator ${filter.operator}`);
  }
}

/**
 * Compiles the safe DALgo subset to Solr's JSON Request API. It deliberately
 * uses JSON query objects rather than interpolating values into Lucene syntax.
 */
export function compileSolrQuery<T>(
  query: StructuredQuery<T>,
  idField: string,
  maxQueryLimit = 1_000,
): CompiledSolrQuery {
  validateSolrField(idField);
  if (!Number.isSafeInteger(maxQueryLimit) || maxQueryLimit <= 0) {
    throw new RangeError("maxQueryLimit must be a positive safe integer");
  }
  if (query.source.kind === "collection-group") {
    throw new UnsupportedError("Solr collection-group queries");
  }
  if (query.source.parent !== undefined) {
    throw new UnsupportedError("Solr nested collection queries");
  }
  if (
    query.startAt !== undefined
    || query.startAfter !== undefined
    || query.endAt !== undefined
    || query.endBefore !== undefined
  ) {
    throw new UnsupportedError("Solr DALgo value cursors; use offset pagination or Solr cursorMark directly outside this adapter");
  }

  const body: JsonObject = {
    query: "*:*",
    ...(query.filters.length === 0
      ? {}
      : { filter: query.filters.map((filter) => filterClause(filter, idField, query.source.name)) }),
  };
  if (query.orders.length > 0) {
    body.sort = query.orders.map((order) => `${fieldName(order.field, idField)} ${order.direction}`).join(",");
  }
  if (query.limit !== undefined && query.limit > maxQueryLimit) {
    throw new RangeError(`Solr query limit cannot exceed configured maxQueryLimit (${String(maxQueryLimit)})`);
  }
  body.limit = query.limit ?? maxQueryLimit;
  if (query.offset !== undefined) body.offset = query.offset;
  return { body };
}
