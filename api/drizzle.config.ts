import { loadEnvFile } from "node:process";

import { defineConfig } from "drizzle-kit";

loadEnvFile();

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for db:push");
}

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  strict: true,
  verbose: true,
});
