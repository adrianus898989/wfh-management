const CRON_TOKEN_HASH="988aa6dfb0151861cb16ed2e197ee137cff51cd2625e6c85c24cf04696f08a56";
const SOURCE_REF="vlabmqvbfhdkjsxhajkp";
const SOURCE_DB_URL="https://vlabmqvbfhdkjsxhajkp.supabase.co";
// Publishable keys are intentionally public. The old exam frontend already
// uses this key; RLS limits it to the readable legacy question cache.
const SOURCE_PUBLISHABLE_KEY="sb_publishable_lLVfzEg592vAo9Ap1q-omg_QjWx0OQs";
const BATCH_SIZE=250;
const H={"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:H});

async function hash(v:string){
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function equal(a:string,b:string){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0}

const BASE=Deno.env.get("SUPABASE_URL")!;
const KEY=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function db(path:string,init:RequestInit={}){
  const r=await fetch(`${BASE}/rest/v1/${path}`,{
    ...init,
    headers:{apikey:KEY,authorization:`Bearer ${KEY}`,"content-type":"application/json",...(init.headers||{})}
  });
  if(!r.ok){
    const detail=(await r.text()).slice(0,500);
    console.error("legacy sync destination request failed",path,r.status,detail);
    throw new Error(`destination request failed: ${r.status}`);
  }
  if(r.status===204)return null;
  const text=await r.text();
  return text?JSON.parse(text):null;
}

async function source(url:string,token:string,body:unknown){
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-legacy-sync-token":token},body:JSON.stringify(body)});
  if(!r.ok){
    console.error("legacy source request failed",r.status,(await r.text()).slice(0,300));
    throw new Error(`source request failed: ${r.status}`);
  }
  return await r.json();
}

async function state(){
  const rows=await db(`legacy_exam_sync_state?source_project_ref=eq.${SOURCE_REF}&select=*`);
  if(!rows?.length)throw new Error("sync state missing");
  return rows[0];
}
async function patchState(values:Record<string,unknown>){
  return await db(`legacy_exam_sync_state?source_project_ref=eq.${SOURCE_REF}`,{method:"PATCH",headers:{Prefer:"return=representation"},body:JSON.stringify({...values,updated_at:new Date().toISOString()})});
}
async function rpc(name:string,body:unknown={}){
  return await db(`rpc/${name}`,{method:"POST",body:JSON.stringify(body)});
}
async function upsert(table:string,data:any[],conflict:string,returnRows=true){
  if(!data.length)return [];
  return await db(`${table}?on_conflict=${encodeURIComponent(conflict)}`,{
    method:"POST",
    headers:{Prefer:`resolution=merge-duplicates,return=${returnRows?"representation":"minimal"}`},
    body:JSON.stringify(data)
  });
}

const norm=(v:unknown)=>String(v||"").trim().toUpperCase().replace(/[^A-Z0-9]+/g,"");
const number=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?n:null};
const time=(...values:unknown[])=>{
  const valid=values.filter(Boolean).map(v=>new Date(String(v)).getTime()).filter(Number.isFinite);
  return new Date(valid.length?Math.max(...valid):Date.now()).toISOString();
};
function points(q:any){return number(q?.points??q?.score??q?.Scores??q?.["分数 Scores"])??0}
function grade(a:any,p:number){
  const s=number(a.score)??0;
  if(!a.graded_at)return "pending";
  if(a.is_correct===true)return "correct";
  if(a.is_correct===false)return s>0&&p>0&&s<p?"partial":"wrong";
  if(p>0&&s>=p)return "correct";
  if(s>0)return "partial";
  return "wrong";
}

const QUESTION_SELECT="id,question_en,question_zh,question_vi,score,image_url,image_1,image_2,image_3,series,position,difficulty,topic,option_a,option_b,option_c,option_d,is_active,synced_at";
function questionImages(q:any){
  return [q.image_url,q.image_1,q.image_2,q.image_3].map(v=>String(v||"").trim()).filter(Boolean);
}
function questionSnapshot(q:any){
  if(!q)return {};
  return {id:q.id,question_en:q.question_en||"",question_zh:q.question_zh||"",question_vi:q.question_vi||"",points:points(q),score:points(q),image_urls:questionImages(q),series:q.series||null,position:q.position||null,difficulty:q.difficulty||null};
}
function questionCacheRow(q:any){
  return {source_project_ref:SOURCE_REF,source_question_id:q.id,question_en:q.question_en||null,question_zh:q.question_zh||null,question_vi:q.question_vi||null,points:points(q),image_urls:questionImages(q),series_name:q.series||null,position_name:q.position||null,difficulty:q.difficulty==null?null:String(q.difficulty),source_payload:q,synced_at:new Date().toISOString()};
}
async function questionRequest(params:URLSearchParams){
  const r=await fetch(`${SOURCE_DB_URL}/rest/v1/questions_cache?${params.toString()}`,{headers:{apikey:SOURCE_PUBLISHABLE_KEY}});
  if(!r.ok){
    console.error("legacy question request failed",r.status,(await r.text()).slice(0,300));
    throw new Error(`legacy question request failed: ${r.status}`);
  }
  return await r.json();
}
async function sourceQuestions(ids:string[]){
  const unique=[...new Set(ids.filter(Boolean))],rows:any[]=[];
  for(let i=0;i<unique.length;i+=80){
    const params=new URLSearchParams({select:QUESTION_SELECT,limit:"1000"});
    params.set("id",`in.(${unique.slice(i,i+80).join(",")})`);
    rows.push(...await questionRequest(params));
  }
  return rows;
}
async function backfillQuestions(){
  let offset=0,total=0;
  while(true){
    const params=new URLSearchParams({select:QUESTION_SELECT,limit:"1000",offset:String(offset),order:"id.asc"});
    const rows=await questionRequest(params);
    for(let i=0;i<rows.length;i+=250)await upsert("legacy_exam_questions",rows.slice(i,i+250).map(questionCacheRow),"source_project_ref,source_question_id",false);
    total+=rows.length;
    if(rows.length<1000)break;
    offset+=rows.length;
  }
  const updated=await rpc("legacy_exam_apply_question_snapshots");
  await rpc("legacy_exam_refresh_employee_matches");
  return {questions:total,answers_updated:Number(updated||0)};
}

async function employees(){
  const list=await db("employees?select=id,employee_no&limit=5000");
  const exact=new Map<string,any[]>();
  for(const e of list||[]){const k=norm(e.employee_no);if(!k)continue;exact.set(k,[...(exact.get(k)||[]),e])}
  const ordered=[...(list||[])].filter((e:any)=>norm(e.employee_no)).sort((a:any,b:any)=>norm(b.employee_no).length-norm(a.employee_no).length);
  return {exact,ordered};
}
function matchEmployee(username:unknown,catalog:any){
  const key=norm(username),matches=catalog.exact.get(key)||[];
  if(matches.length===1)return {employee_id:matches[0].id,status:"matched"};
  if(matches.length>1)return {employee_id:null,status:"ambiguous"};
  const pref=catalog.ordered.filter((e:any)=>{const k=norm(e.employee_no);return key.startsWith(k)&&key.length>k.length&&!/^\d/.test(key.slice(k.length,1))});
  return pref.length===1?{employee_id:pref[0].id,status:"matched"}:{employee_id:null,status:pref.length>1?"ambiguous":"unmatched"};
}

async function importBatch(sessions:any[],sourceToken:string,exporterUrl:string){
  if(!sessions.length)return {sessions:0,answers:0};
  const catalog=await employees(),now=new Date().toISOString();
  const payload=sessions.map(s=>{
    const m=matchEmployee(s.profile?.username,catalog),earned=number(s.score);
    return {
      source_project_ref:SOURCE_REF,source_session_id:s.id,source_user_id:s.user_id,
      employee_id:m.employee_id,employee_no:s.profile?.username||null,employee_name:s.profile?.full_name||null,employee_match_status:m.status,
      status:["in_progress","submitted","graded"].includes(s.status)?s.status:"submitted",
      series_name:s.series||null,position_name:s.position||null,started_at:s.started_at,submitted_at:s.submitted_at||null,graded_at:s.graded_at||null,
      duration_minutes:number(s.duration_minutes),earned_score:earned,total_score:100,
      percentage:s.status==="graded"?earned:null,passed:s.status==="graded"&&earned!=null?earned>=60:null,
      total_questions:number(s.total_questions),correct_count:number(s.correct_count),submission_count:number(s.submission_count),
      question_ids:Array.isArray(s.question_ids)?s.question_ids:[],source_changed_at:time(s.started_at,s.submitted_at,s.graded_at),
      source_payload:s,synced_at:now
    };
  });
  const imported=await upsert("legacy_exam_sessions",payload,"source_project_ref,source_session_id");
  const bySource=new Map((imported||[]).map((x:any)=>[String(x.source_session_id),x.id]));
  let answerCount=0;
  const ids=sessions.map(s=>String(s.id));
  for(let i=0;i<ids.length;i+=25){
    let offset=0;const group=ids.slice(i,i+25);
    while(true){
      const response=await source(exporterUrl,sourceToken,{mode:"submissions",session_ids:group,offset,limit:1000});
      const sourceAnswers=response.data||[];
      const questions=await sourceQuestions(sourceAnswers.map((a:any)=>String(a.question_id||"")));
      if(questions.length)await upsert("legacy_exam_questions",questions.map(questionCacheRow),"source_project_ref,source_question_id",false);
      const questionMap=new Map(questions.map((q:any)=>[String(q.id),q]));
      const answers=sourceAnswers.map((a:any)=>{
        const cached=questionSnapshot(questionMap.get(String(a.question_id)));
        const q={...cached,...(a.question_snapshot||{})},p=points(q);
        return {
          legacy_session_id:bySource.get(String(a.session_id)),source_project_ref:SOURCE_REF,source_submission_id:a.id,
          source_session_id:a.session_id,source_question_id:a.question_id||null,question_snapshot:q,
          answer_text:a.user_answer||"",is_correct:a.is_correct,awarded_score:number(a.score),question_points:p,grade_status:grade(a,p),
          attachments:Array.isArray(a.image_urls)?a.image_urls:[],feedback:a.feedback||"",
          feedback_images:Array.isArray(a.feedback_images)?a.feedback_images:[],answered_at:a.answered_at||null,graded_at:a.graded_at||null,
          source_payload:a,synced_at:now
        };
      }).filter((a:any)=>a.legacy_session_id);
      await upsert("legacy_exam_answers",answers,"source_project_ref,source_submission_id");
      answerCount+=answers.length;
      if(!response.has_more||!answers.length)break;
      offset=response.next_offset;
    }
  }
  return {sessions:imported?.length||sessions.length,answers:answerCount};
}

async function exactCount(table:string){
  const r=await fetch(`${BASE}/rest/v1/${table}?source_project_ref=eq.${SOURCE_REF}&select=id&limit=1`,{headers:{apikey:KEY,authorization:`Bearer ${KEY}`,Prefer:"count=exact"}});
  if(!r.ok)return 0;
  const range=r.headers.get("content-range")||"0-0/0",total=Number(range.split("/")[1]);
  return Number.isFinite(total)?total:0;
}

Deno.serve(async(req:Request)=>{
  if(req.method!=="POST")return reply({error:"Method not allowed."},405);
  const cron=req.headers.get("x-legacy-cron-token")||"",sourceToken=req.headers.get("x-legacy-source-token")||"";
  if(!cron||!equal(await hash(cron),CRON_TOKEN_HASH)||!sourceToken)return reply({error:"Unauthorized."},401);
  let requested:any={};
  try{requested=await req.json()}catch{}
  try{
    if(requested?.mode==="backfill_questions")return reply({ok:true,mode:"backfill_questions",...await backfillQuestions()});
    const st:any=await state(),now=Date.now(),last=st.last_attempt_at?new Date(st.last_attempt_at).getTime():0;
    if(st.status==="running"&&now-last<5*60*1000)return reply({ok:true,skipped:true,reason:"already_running"});
    await patchState({status:"running",last_attempt_at:new Date().toISOString(),last_error:null});
    let sessions:any[]=[],mode="incremental",sourceResponse:any;
    if(!st.full_sync_completed){
      mode="full";
      sourceResponse=await source(st.exporter_url,sourceToken,{mode:"sessions",scope:"all",offset:st.full_sync_offset,limit:BATCH_SIZE});
      sessions=sourceResponse.data||[];
    }else{
      const cursor=new Date(new Date(st.incremental_cursor).getTime()-10*60*1000).toISOString();
      const [changed,pending]=await Promise.all([
        source(st.exporter_url,sourceToken,{mode:"sessions",scope:"changed",since:cursor,limit:500}),
        source(st.exporter_url,sourceToken,{mode:"sessions",scope:"pending",offset:0,limit:500})
      ]);
      const m=new Map<string,any>();
      [...(changed.data||[]),...(pending.data||[])].forEach(x=>m.set(String(x.id),x));
      sessions=[...m.values()];sourceResponse=changed;
    }
    const result=await importBatch(sessions,sourceToken,st.exporter_url);
    const fullDone=mode==="full"&&!sourceResponse.has_more;
    const sessionTotal=await exactCount("legacy_exam_sessions"),answerTotal=await exactCount("legacy_exam_answers");
    await patchState({
      status:"success",last_success_at:new Date().toISOString(),last_error:null,
      full_sync_offset:mode==="full"?Number(st.full_sync_offset)+sessions.length:st.full_sync_offset,
      full_sync_completed:mode==="full"?fullDone:st.full_sync_completed,
      incremental_cursor:mode==="incremental"?(sourceResponse.generated_at||new Date().toISOString()):st.incremental_cursor,
      total_sessions_synced:sessionTotal,total_answers_synced:answerTotal,
      last_batch_sessions:result.sessions,last_batch_answers:result.answers
    });
    return reply({ok:true,mode,full_sync_completed:mode==="full"?fullDone:true,source_count:sessions.length,...result,total_sessions:sessionTotal,total_answers:answerTotal});
  }catch(e){
    console.error("legacy exam sync failed",e);
    try{await patchState({status:"error",last_error:e instanceof Error?e.message:String(e)})}catch{}
    return reply({error:"Legacy exam synchronization failed."},500);
  }
});
