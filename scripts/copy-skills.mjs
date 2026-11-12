import { cpSync, mkdirSync } from "node:fs";

// The connector resolves prompt assets relative to its own module in source and
// compiled installations. Keep upstream attribution and all runtime references.
mkdirSync("dist/server/skills", { recursive: true });
cpSync("src/skills/chineseplz", "dist/server/skills/chineseplz", {
  recursive: true,
});
