import {
  DOCUMENT_ID,
  UnsupportedError,
  collection,
  collectionGroup,
  key,
  type StructuredQuery,
} from "@dal-go/dalgo";
import { describe, expect, it } from "vitest";
import { compileSolrQuery } from "../src/query.js";

interface Product { price: number; category: string; active: boolean }

function rawQuery(name: string): StructuredQuery<unknown> {
  return { source: { kind: "collection", name }, filters: [], orders: [] };
}

describe("compileSolrQuery", () => {
  it("uses JSON DSL clauses for safe filters and maps sort, limit, and offset", () => {
    const query = collection<Product>("products").query()
      .where("category", "==", "books")
      .where("price", ">=", 10)
      .where("active", "in", [true, false])
      .where(DOCUMENT_ID, "==", key("products", "p-1"))
      .orderBy("price", "desc")
      .orderBy(DOCUMENT_ID)
      .offset(5)
      .limit(10)
      .build();

    expect(compileSolrQuery(query, "id", 100).body).toEqual({
      query: "*:*",
      filter: [
        { field: { f: "category", query: "books" } },
        { frange: { l: 10, query: "price" } },
        { bool: { should: [
          { field: { f: "active", query: true } },
          { field: { f: "active", query: false } },
        ] } },
        { field: { f: "id", query: "p-1" } },
      ],
      sort: "price desc,id asc",
      offset: 5,
      limit: 10,
    });
  });

  it("maps strict range bounds without query-string interpolation", () => {
    const less = collection<Product>("products").query().where("price", "<", 10).build();
    const more = collection<Product>("products").query().where("price", ">", 10).build();
    expect(compileSolrQuery(less, "id", 100).body.filter).toEqual([{ frange: { u: 10, incu: false, query: "price" } }]);
    expect(compileSolrQuery(more, "id", 100).body.filter).toEqual([{ frange: { l: 10, incl: false, query: "price" } }]);
  });

  it("rejects unsupported topology, operators, cursors, and unsafe fields", () => {
    expect(() => compileSolrQuery(collectionGroup("items").build(), "id", 100)).toThrow(UnsupportedError);
    expect(() => compileSolrQuery(collection("items", { parent: key("parents", "p1") }).query().build(), "id", 100)).toThrow(UnsupportedError);
    expect(() => compileSolrQuery(collection("items").query().startAfter("a").build(), "id", 100)).toThrow(UnsupportedError);
    expect(() => compileSolrQuery(collection<Product>("items").query().where("category", "!=", "a").build(), "id", 100)).toThrow(UnsupportedError);
    expect(() => compileSolrQuery(collection<Product>("items").query().where("category", "in", []).build(), "id", 100)).toThrow("non-empty");
    expect(() => compileSolrQuery(collection<Product>("items").query().where("category bad", "==", "a").build(), "id", 100)).toThrow("unsafe");
    expect(() => compileSolrQuery(collection<Product>("items").query().where(DOCUMENT_ID, "==", key("other", "a")).build(), "id", 100)).toThrow("belongs");
    expect(() => compileSolrQuery(rawQuery("items"), "bad field", 100)).toThrow("unsafe");
    expect(() => compileSolrQuery(collection("items").query().limit(101).build(), "id", 100)).toThrow("maxQueryLimit");
  });
});
