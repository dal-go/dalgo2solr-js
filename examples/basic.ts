import { collection } from "@dal-go/dalgo";
import { SolrDatabase } from "../src/index.js";

interface Product {
  readonly name: string;
  readonly price: number;
  readonly category: string;
}

const products = collection<Product>("products");
const accessToken = "<short-lived-token-from-your-trusted-broker>";
const database = new SolrDatabase({
  baseUrl: "https://solr.example/solr",
  headers: () => ({ Authorization: `Bearer ${accessToken}` }),
  // Solr's collection schema must declare `id` as its unique-key field.
  idField: "id",
  commitWithinMs: 1_000,
});

await database.set(products.key("p-1"), { name: "DALgo", price: 25, category: "books" });

const page = await database.query(
  products.query().where("price", ">=", 10).orderBy("price").limit(20).build(),
);
console.log(page.records.map((record) => record.data));
