# DALgo adapter for Apache Solr

`@dal-go/dalgo2solr` implements the [`@dal-go/dalgo`](https://github.com/dal-go/dalgo-js)
database contracts over Apache Solr's JSON Request API and JSON update handlers.
It is an HTTP-capable, trusted-runtime adapter: it is not a browser-ready way
to expose Solr directly to untrusted JavaScript.

## Install

```sh
pnpm add github:dal-go/dalgo-js github:dal-go/dalgo2solr-js
```

The repositories build as `@dal-go/dalgo` and `@dal-go/dalgo2solr`; neither
package has been published to npm yet.

## Setup

Every DALgo collection maps to one Solr collection/core. The adapter needs a
schema unique-key field, `id` by default. It reserves that field and Solr's
`_version_` field; application codecs must not encode either one.

```ts
import { collection } from "@dal-go/dalgo";
import { SolrDatabase } from "@dal-go/dalgo2solr";

interface Product {
  readonly name: string;
  readonly price: number;
  readonly category: string;
}

const products = collection<Product>("products");
const db = new SolrDatabase({
  baseUrl: "https://solr.example/solr",
  idField: "id",
  headers: async () => ({
    Authorization: `Bearer ${await mintShortLivedAccessToken()}`,
  }),
  // Optional: Solr makes writes searchable within this time if it can.
  commitWithinMs: 1_000,
  // Every query gets a limit. This is the unrequested-query ceiling.
  maxQueryLimit: 500,
});

await db.insert(products.key("p-1"), { name: "DALgo", price: 25, category: "books" });

const page = await db.query(
  products.query()
    .where("category", "==", "books")
    .where("price", ">=", 10)
    .orderBy("price")
    .limit(20)
    .build(),
);
```

`baseUrl` is an HTTPS Solr context root such as `https://host.example/solr`.
HTTP is only accepted for loopback development. URLs containing a user name,
password, query, or fragment are rejected. Requests have a 30-second deadline
by default, reject redirects, resolve header factories on every request, cap
buffered responses at 1 MiB by default (`responseMaxBytes`), and do not put
credentials or server response bodies in errors.

## Supported DALgo surface

- top-level collection CRUD: `get`, `getMany`, `insert`, `set`, `update`, and `delete`
- query `==`, `in`, `<`, `<=`, `>`, and `>=` filters, combined with AND
- ascending/descending ordering, limits, and offsets; multi-column sorts use
  Solr's comma-separated sort syntax
- every query sends a limit. `maxQueryLimit` defaults to 1,000 and is both the
  default limit and a hard cap; requests above it reject before HTTP rather
  than silently inheriting Solr's server default (commonly ten results)
- document `_version_` returned as record metadata when Solr stores it
- `insert` uses `_version_:-1` (must not already exist); `update` uses
  `_version_:1` (must already exist) and Solr atomic `set` field updates

Solr field interpretation still depends on the collection schema. Equality and
membership use the JSON DSL `field` query parser; ranges use `frange`. Use
schema fields appropriate for exact values and ranges. The adapter never
interpolates filter values into Lucene query strings.

## Intentional limitations

- Nested DALgo collections and collection groups are rejected: Solr collections
  are independent indexes.
- `!=`, `not-in`, `array-contains`, and `array-contains-any` are rejected.
  Their missing-field, analysis, and multivalued-field behavior cannot be
  represented uniformly across Solr schemas.
- DALgo value cursors are rejected. Solr `cursorMark` has different semantics;
  use offset pagination for bounded result windows, or use Solr directly when
  you specifically need cursorMark.
- No DALgo transaction is fabricated. Solr's documented atomicity is per
  document, not a multi-document ACID transaction.
- DALgo does not carry an expected document version on writes. The adapter
  exposes `_version_` in metadata but cannot offer exact-version compare and
  set; use Solr directly if that operation is required.
- A write acknowledgement, real-time get visibility, and search visibility are
  different. Configure Solr auto-commit or `commitWithinMs` for your required
  search visibility and durability policy.
- Documents and atomic-update values must be JSON-safe: finite numbers, null,
  strings, booleans, arrays, and plain objects only. Cycles, `undefined`,
  `BigInt`, functions, symbols, and class instances reject before a request.
  Atomic `update` rejects `null`; field removal is not representable in DALgo's
  `UpdateData` and is intentionally not mapped to Solr's schema-dependent
  null/update behavior.

## Browser and security posture

Apache Solr states that no Solr API is designed to be exposed to non-trusted
parties. Although deployments can configure CORS and authentication plugins,
that is not a safe public-client credential model. Put this adapter behind a
trusted service that applies application authorization and mints narrowly
scoped, short-lived credentials if a browser must initiate the operation.
Never ship Basic-auth passwords, bearer tokens, or administrative credentials
to browser code. Configure TLS, Solr authentication/authorization, and a
network firewall/allow-list.

## Official references

- [JSON Request API](https://solr.apache.org/guide/solr/latest/query-guide/json-request-api.html)
- [JSON Query DSL](https://solr.apache.org/guide/solr/latest/query-guide/json-query-dsl.html)
- [Indexing with Update Handlers](https://solr.apache.org/guide/solr/latest/indexing-guide/indexing-with-update-handlers.html)
- [Partial Document Updates and optimistic concurrency](https://solr.apache.org/guide/solr/latest/indexing-guide/partial-document-updates.html)
- [Securing Solr](https://solr.apache.org/guide/solr/latest/deployment-guide/securing-solr.html)

## License

MIT
