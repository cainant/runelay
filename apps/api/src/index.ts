import { app } from "@/app";
import { env } from "@/config/env";
import { migrateAuth } from "@/modules/auth/lib/migrate-auth";
import { setupUrl } from "@/modules/auth/lib/setup-token";
import { countUsers } from "@/modules/auth/repositories/user.repository";
import { rehashSourceUrls } from "@/modules/sources/repositories/source.repository";

await migrateAuth();
rehashSourceUrls();

Bun.serve({ hostname: env.HOST, port: env.PORT, idleTimeout: 0, fetch: app.fetch });

console.log(`runelay em ${env.PUBLIC_URL} · API em /v1 · MCP em /v1/mcp`);

if (countUsers() === 0) {
  console.log(`\nPrimeiro acesso: crie a conta dona por este link (só ele funciona):\n${setupUrl()}\n`);
}
