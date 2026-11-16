import { defineConfig } from "drizzle-kit";

// `generate` needs no connection. `migrate` is applied at deploy time only;
// never run it locally against prod.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
