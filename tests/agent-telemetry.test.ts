import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentHost } from "../src/agent.js";
import { Providers } from "../src/providers.js";
import { testConfig, snapshot } from "./fixtures.js";
import type { AgentEvent, Backend } from "../src/types.js";
import { structuredReply } from "../src/util.js";
test("merged commentary accepts only a complete trailing JSON object and preserves HTML braces", () => {
  const output = {
    html: "<style>body { color: red; }</style>",
    answer: "Done",
  };
  const text =
    "Public update.\n```json\n" + JSON.stringify(output, null, 2) + "\n```";
  assert.deepEqual(structuredReply(text), {
    output,
    commentary: "Public update.",
  });
  assert.deepEqual(structuredReply("Public update." + JSON.stringify(output)), {
    output,
    commentary: "Public update.",
  });
  assert.throws(
    () => structuredReply('Update\n{"answer":"Done"}\nadditional prose'),
    /structured result/,
  );
});
const peer = `#!/usr/bin/env node
const {createInterface}=require('node:readline');
if(process.argv.includes('--version')){console.log('synthetic-agent 1');process.exit(0)}
const counts=n=>({inputTokens:n,cachedInputTokens:n/2,outputTokens:n/10,reasoningOutputTokens:n/20,totalTokens:n+n/10});
let baseline=0;
const send=m=>console.log(JSON.stringify(m));
const note=(method,params)=>send({method,params:{threadId:'thread',turnId:'turn',...params}});
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='account/read')result={account:{type:'synthetic-owner'}};
if(m.method==='thread/start'||m.method==='thread/resume'){baseline=m.method==='thread/resume'?1000:0;result={thread:{id:'thread'},model:'test-model'};}
if(m.method==='thread/read')result={thread:{id:'thread'}};
if(m.method==='turn/start')result={turn:{id:'turn'}};
send({id:m.id,result});
if(m.method==='thread/resume')note('thread/tokenUsage/updated',{turnId:'previous',tokenUsage:{total:counts(baseline)}});
if(m.method==='turn/start'){
 note('turn/started',{turn:{id:'turn'}});
 note('item/started',{item:{id:'reason',type:'reasoning',content:['PRIVATE REASONING']}});
 note('item/reasoning/textDelta',{delta:'PRIVATE REASONING'});
 note('item/completed',{item:{id:'comment',type:'agentMessage',phase:'commentary',text:'I am checking the source.'}});
 note('thread/tokenUsage/updated',{tokenUsage:{total:counts(baseline+200)}});
 note('thread/tokenUsage/updated',{tokenUsage:{total:counts(baseline+200)}});
 note('item/started',{item:{id:'answer',type:'agentMessage',phase:'final_answer',text:''}});
 note('item/agentMessage/delta',{itemId:'answer',delta:'PRIVATE PARTIAL JSON'});
 note('thread/tokenUsage/updated',{tokenUsage:{total:counts(baseline+400)}});
 note('item/completed',{item:{id:'answer',type:'agentMessage',phase:__filename.includes('traex')?'commentary':'final_answer',text:(__filename.includes('traex')?'Public update.':'')+'{"answer":"Verified synthetic answer"}'}});
 note('turn/completed',{turn:{id:'turn',status:'completed'}});
}});`;
for (const backend of ["codex", "traex"] as Backend[])
  test(`${backend} native events forward public feedback and run-scoped usage without reasoning or partial JSON`, async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "unfold-native-telemetry-"),
    );
    try {
      const executable = path.join(root, `peer-${backend}.cjs`),
        authFile = path.join(root, "auth.json");
      await writeFile(executable, peer, { mode: 0o700 });
      await writeFile(authFile, "{}");
      const config = testConfig(root);
      config.agents[backend] = { executable, authFile };
      const host = new AgentHost(config, root, new Providers(config));
      for (const threadId of [undefined, "thread"]) {
        const events: AgentEvent[] = [];
        await host.run(
          {
            runId: "run",
            snapshot,
            backend,
            kind: "question",
            question: "Check",
            threadId,
          },
          (e) => events.push(e),
          new AbortController().signal,
        );
        const usage = events.filter((e) => e.type === "usage");
        assert.equal(usage.length, 2);
        assert.equal((usage.at(-1)?.usage as any).totalTokens, 440);
        assert.ok(
          events.some((e) => e.message === "I am checking the source."),
        );
        assert.ok(
          events.some((e) => e.stage === "generating" && e.outputChars === 20),
        );
        assert.ok(!JSON.stringify(events).includes("PRIVATE REASONING"));
        assert.ok(!JSON.stringify(events).includes("PRIVATE PARTIAL JSON"));
        assert.equal(events.at(-1)?.type, "result");
        assert.ok(
          events
            .filter((e) => e.type === "status")
            .every((e) => !String(e.message).includes('"answer"')),
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
