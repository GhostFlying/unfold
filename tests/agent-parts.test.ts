import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentHost } from "../src/agent.js";
import { ArtifactDraft } from "../src/artifact-draft.js";
import { Providers } from "../src/providers.js";
import { testConfig, snapshot, sourceText } from "./fixtures.js";
import type { AgentEvent, Backend } from "../src/types.js";

const peer = `#!/usr/bin/env node
const {createInterface}=require('node:readline');
const assert=require('node:assert/strict');
if(process.argv.includes('--version')){console.log('synthetic-parts 1');process.exit(0)}
const send=x=>console.log(JSON.stringify(x));
const call=(id,tool,args)=>send({id,method:'item/tool/call',params:{tool,arguments:args}});
const note=(method,params)=>send({method,params:{threadId:'thread',turnId:'turn',...params}});
let ref, pieces;
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 if(m.method){
  let result={};
  if(m.method==='account/read')result={account:{type:'owner'}};
  if(m.method==='thread/start'){
   assert.ok(m.params.dynamicTools.some(t=>t.name==='save_explanation_part'));
   result={thread:{id:'thread'},model:'test-model'};
  }
  if(m.method==='turn/start'){
   assert.deepEqual(m.params.outputSchema.required,['completed']);
   assert.ok(m.params.input[0].text.includes('Save output incrementally'));
   result={turn:{id:'turn'}};
  }
  send({id:m.id,result});
  if(m.method==='turn/start'){note('turn/started',{turn:{id:'turn'}});call(100,'read_source',{path:'src/queue.ts',side:'new',start:1,end:4});}
 }else{
  assert.equal(m.result.success,true,JSON.stringify(m.result));
  if(m.id===100){
   ref=JSON.parse(m.result.contentItems[0].text).reference.id;
   const group={title:'Cancellation',category:'Behavior',summary:'Check first',responsibility:'Control admission',reviewFocus:['Check cancelled work'],context:[],points:[{title:'Guard',summary:'Exit before acquiring',before:'Acquire first',after:'Check first',rationale:'Avoid wasted work',risks:['Source only'],files:['src/queue.ts'],referenceIds:[ref]}]};
   pieces=[{kind:'overview',index:1,content:JSON.stringify({title:'Incremental result',summary:'Source-backed summary'})},{kind:'guide',index:1,content:JSON.stringify(group)},...Array.from({length:4},(_,i)=>({kind:'html',index:i+1,content:(i===0?'<h1>Incremental</h1><a data-unfold-ref="'+ref+'">Source</a>':'')+'<p>'+('PRIVATE-PART-SENTINEL '.repeat(300))+'</p>'}))];
  }
  const next=m.id-100;
  if(next<pieces.length)call(101+next,'save_explanation_part',pieces[next]);
  else if(__filename.includes('failure')){
   note('error',{willRetry:false,error:{message:'model output limit exceeded: length'}});
   note('turn/completed',{turn:{id:'turn',status:'failed',error:{message:'model output limit exceeded: length'}}});
  }else{
   note('item/completed',{item:{id:'final',type:'agentMessage',phase:'final_answer',text:'{"completed":true}'}});
   note('turn/completed',{turn:{id:'turn',status:'completed'}});
  }
 }
});`;

for (const backend of ["traex", "codex"] as Backend[]) {
  for (const failure of [false, true])
    test(`${backend} saves multiple native outputs and ${failure ? "retains private parts on length failure" : "publishes only a completely validated assembly"}`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "unfold-parts-"));
      try {
        const config = testConfig(root),
          executable = path.join(
            root,
            `peer-${failure ? "failure" : "success"}.cjs`,
          ),
          authFile = path.join(root, "auth.json");
        await writeFile(executable, peer, { mode: 0o700 });
        await writeFile(authFile, "{}");
        config.agents[backend] = { executable, authFile };
        const providers = new Providers(config);
        providers.source = async (snap, file, side) => ({
          id: "synthetic-source",
          versionId: snap.id,
          path: file,
          side,
          commit: side === "new" ? snap.head : snap.base,
          content: sourceText,
        });
        const host = new AgentHost(config, root, providers),
          events: AgentEvent[] = [];
        const operation = host.run(
          {
            runId: "parts-run",
            snapshot,
            backend,
            kind: "analysis",
            profile: { model: "test-model" },
          },
          (e) => events.push(e),
          new AbortController().signal,
        );
        if (failure)
          await assert.rejects(
            operation,
            (error: any) => error.code === "agent_output_limit",
          );
        else await operation;
        const draft = new ArtifactDraft(
          config.dataDir,
          "parts-run",
          snapshot.id,
        );
        assert.equal(draft.progress().savedParts, 6);
        assert.ok(draft.assemble().html.length > 16000);
        assert.ok(draft.read().references.length > 0);
        assert.equal(
          events.filter((e) => e.type === "result").length,
          failure ? 0 : 1,
        );
        const saved = events.filter((e) => e.type === "status" && e.savedParts);
        assert.equal(saved.at(-1)?.savedParts, 6);
        assert.ok(
          !JSON.stringify(events.filter((e) => e.type === "status")).includes(
            "PRIVATE-PART-SENTINEL",
          ),
        );
        if (!failure) {
          const artifact = events.find((e) => e.type === "result")!
            .artifact as any;
          assert.equal(artifact.guide.groups[0].points[0].id, "g1-c1");
          assert.equal(artifact.html, draft.assemble().html);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
}
