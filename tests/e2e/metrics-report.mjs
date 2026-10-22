import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const round = n => Math.round(n * 10) / 10;
const dimensions = ['platform','arch','browserVersion','headless','inputMode','bridgeBuild','suiteHash'];
export function distribution(values) {
  if (!values.length) return null;
  if (values.some(n => !Number.isFinite(n) || n < 0)) throw new Error('Measurements must be finite nonnegative numbers');
  const sorted = [...values].sort((a,b)=>a-b), at = p => sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
  return {n:sorted.length,p50:round(at(.5)),p95:round(at(.95)),min:round(sorted[0]),max:round(sorted.at(-1))};
}
const sum = (items,key) => items.reduce((n,item)=>n+(Number.isFinite(item[key]) ? item[key] : 0),0);
const measured = (items,key) => distribution(items.map(x=>x[key]).filter(Number.isFinite));
export function summarize(run) {
  if(run.schemaVersion !== 1) throw new Error('Unsupported metrics schema');
  const groups=new Map();
  for(const call of run.calls) { const key=call.scenario+'\0'+call.tool; if(!groups.has(key))groups.set(key,[]); groups.get(key).push(call); }
  const timings=[...groups.values()].map(calls=>({
    scenario:calls[0].scenario,tool:calls[0].tool,duration:distribution(calls.map(c=>c.durationMs)),
    failed:calls.filter(c=>!c.ok).length,errors:Object.fromEntries([...new Set(calls.filter(c=>!c.ok).map(c=>c.errorCode??'UNKNOWN'))].map(code=>[code,calls.filter(c=>(c.errorCode??'UNKNOWN')===code&&!c.ok).length])),
    outcomeBytes:measured(calls,'outcomeBytes'),browserMs:measured(calls,'browserMs'),snapshotMs:measured(calls,'snapshotMs'),
    longTaskMaxMs:measured(calls,'longTaskMaxMs'),longTaskCount:sum(calls,'longTaskCount'),
  }));
  const oracles=(run.oracles??[]).map(o=>({scenario:o.scenario,passed:o.passed===true,...Object.fromEntries(['wrongTarget','falseSuccess','duplicateWrites','postCancelWrites'].map(k=>[k,Number.isFinite(o[k])?o[k]:0]))}));
  const quality=oracles.length?{n:oracles.length,passed:oracles.filter(o=>o.passed).length,...Object.fromEntries(['wrongTarget','falseSuccess','duplicateWrites','postCancelWrites'].map(k=>[k,sum(oracles,k)]))}:null;
  return {schemaVersion:1,label:run.label,createdAt:run.createdAt??null,complete:run.complete===true,
    environment:Object.fromEntries([...dimensions,'nodeVersion','sourceRevision','extensionSha256','bridgeSha256'].map(k=>[k,run.environment[k]??null])),
    timings,quality,oracles,toolCalls:run.calls.length,explicitSnapshots:run.calls.filter(c=>c.tool==='browser_snapshot').length,
    recoveryErrors:run.calls.filter(c=>['STALE_ELEMENT','EXECUTION_UNKNOWN','BROWSER_DISCONNECTED'].includes(c.errorCode)).length,
    connection:{disconnects:run.connection?.disconnects??null,heartbeat:distribution(run.connection?.heartbeatMs??[]),recoveryMs:run.connection?.recoveryMs??null},
    model:run.model??null,
    notes:['Durations include failed calls. p95 uses nearest rank; fewer than 50 samples is exploratory.',
      'Browser/snapshot times are routed command round trips, not individual DOM prepare/dispatch durations.',
      'Long tasks are browser entries over 50ms and can miss entries delivered after a call. Not a CPU profile.',
      'Quality counts use fixture state, not tool ok. Null means not measured.'],
  };
}
export function compareRuns(beforeRun,afterRun) {
  const before=summarize(beforeRun),after=summarize(afterRun);
  const mismatches=dimensions.filter(k=>before.environment[k]===null || before.environment[k]!==after.environment[k]);
  if(!before.complete||!after.complete)mismatches.push('incomplete-run');
  const comparable=!mismatches.length;
  const key=t=>t.scenario+'\0'+t.tool, keys=new Set([...before.timings,...after.timings].map(key));
  const timings=[...keys].map(k=>{
    const b=before.timings.find(t=>key(t)===k)??null,a=after.timings.find(t=>key(t)===k)??null;
    return {scenario:(a??b).scenario,tool:(a??b).tool,before:b,after:a,p50ChangePercent:comparable&&b&&a&&b.duration.p50>0?round((a.duration.p50/b.duration.p50-1)*100):null};
  });
  return {schemaVersion:1,kind:'comparison',comparable,mismatches,before,after,timings};
}
const esc = value => String(value??'미측정').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number = value => value==null?'—':String(value);
const stats = value => value ? `${value.p50} / ${value.p95} (${value.n})` : '미측정';
function rows(report) {
  if(report.kind==='comparison')return report.timings.map(t=>[t.scenario,t.tool,stats(t.before?.duration),stats(t.after?.duration),t.p50ChangePercent==null?'비교 안 함':`${t.p50ChangePercent}%`,`${t.before?.failed??'—'} → ${t.after?.failed??'—'}`]);
  return report.timings.map(t=>[t.scenario,t.tool,stats(t.duration),stats(t.outcomeBytes),stats(t.browserMs),stats(t.snapshotMs),stats(t.longTaskMaxMs),t.failed]);
}
const headers = comparison => comparison?['시험','도구','이전 p50 / p95 (n), ms','이후 p50 / p95 (n), ms','p50 변화','실패 이전 → 이후']:['시험','도구','p50 / p95 (n), ms','결과 bytes','브라우저 왕복 ms','스냅샷 왕복 ms','최장 long task ms','실패'];
export function renderMarkdown(report) {
  const comparison=report.kind==='comparison',current=comparison?report.after:report;
  const cell=v=>String(v??'미측정').replaceAll('|','\\|').replaceAll('\n',' ');
  const table=(head,body)=>[head,head.map(()=> '---'),...body].map(row=>'| '+row.map(cell).join(' | ')+' |').join('\n');
  return `# 브라우저 품질 측정: ${cell(current.label)}\n\n`+
    `${comparison?(report.comparable?'동일 환경 비교':'시간 비교 제외: '+report.mismatches.join(', ')): '단일 실행'} · ${current.complete?'수집 완료':'수집 미완료'}\n\n`+
    table(['환경','값'],Object.entries(current.environment))+`\n\n`+table(headers(comparison),rows(report))+`\n\n`+
    table(['정확도','값'],Object.entries(current.quality??{status:'미측정'}))+`\n\n`+
    table(['실제 상태 검사','결과'],current.oracles.map(o=>[o.scenario,o.passed?'PASS':'FAIL']))+`\n\n`+
    table(['수집 항목','값'],[['전체 측정 도구 호출',current.toolCalls],['명시적 스냅샷',current.explicitSnapshots],['복구 관련 오류',current.recoveryErrors],['연결 끊김',current.connection.disconnects],['heartbeat p50/p95 (n)',stats(current.connection.heartbeat)],['재연결 ms',current.connection.recoveryMs],['실제 모델',current.model?JSON.stringify(current.model):'미측정']])+`\n\n`+current.notes.map(n=>'- '+n).join('\n')+'\n';
}
export function renderHtml(report) {
  const comparison=report.kind==='comparison',current=comparison?report.after:report;
  const table=(head,body)=>`<div class="scroll"><table><thead><tr>${head.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${body.map(row=>`<tr>${row.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const q=current.quality;
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>브라우저 품질 측정</title><style>body{font:16px/1.6 system-ui,sans-serif;margin:32px auto;padding:0 24px;max-width:1300px;color:#172033;background:#f4f6fa}h1{font-size:28px}h2{font-size:20px;margin-top:32px}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{background:white;border:1px solid #d8deea;padding:16px 24px;border-radius:10px}.card strong{display:block;font-size:28px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;background:white;font-size:14px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #d8deea;white-space:nowrap}th{background:#e7edf7}.notice{padding:12px;background:#fff3ce}code{overflow-wrap:anywhere}li{margin:5px 0}</style><h1>브라우저 품질 측정 · ${esc(current.label)}</h1><p>${esc(current.createdAt)} · ${esc(current.environment.platform)} / Chromium ${esc(current.environment.browserVersion)} / ${esc(current.environment.inputMode)}</p><p class="notice">${comparison?(report.comparable?'동일 환경의 전후 결과입니다. 음수 변화율은 지연 감소입니다.':'환경/완료 상태가 달라 속도 변화율을 계산하지 않습니다: '+esc(report.mismatches.join(', '))):'단일 실행입니다. 같은 환경의 기준선과 비교하세요.'} 표본 50개 미만의 p95는 탐색용입니다. ${current.complete?'수집 완료':'수집 미완료'}</p><div class="cards"><div class="card">실제 상태 검사<strong>${q?`${q.passed} / ${q.n}`:'미측정'}</strong></div><div class="card">잘못된 대상<strong>${number(q?.wrongTarget)}</strong></div><div class="card">잘못된 성공<strong>${number(q?.falseSuccess)}</strong></div><div class="card">중복 / 중단 후 쓰기<strong>${number(q?.duplicateWrites)} / ${number(q?.postCancelWrites)}</strong></div></div><h2>도구 지연과 반환량</h2>${table(headers(comparison),rows(report))}<h2>실제 상태 검사</h2>${table(['시험','이전','현재'],current.oracles.map(o=>[o.scenario,comparison?(report.before.oracles.find(b=>b.scenario===o.scenario)?.passed===true?'PASS':report.before.oracles.some(b=>b.scenario===o.scenario)?'FAIL':'미측정'):'—',o.passed?'PASS':'FAIL']))}<h2>연결과 호출</h2>${table(['항목','값'],[['측정 도구 호출',current.toolCalls],['명시적 snapshot',current.explicitSnapshots],['복구 관련 오류',current.recoveryErrors],['연결 끊김',current.connection.disconnects],['heartbeat p50 / p95 (n), ms',stats(current.connection.heartbeat)],['재연결 시간 ms',current.connection.recoveryMs],['실제 모델',current.model?JSON.stringify(current.model):'미측정']])}<h2>측정 범위</h2><ul>${current.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></html>`;
}
export async function writeReports(directory,report) {
  await mkdir(directory,{recursive:true});
  await Promise.all([['summary.json',JSON.stringify(report,null,2)+'\n'],['report.md',renderMarkdown(report)],['report.html',renderHtml(report)]].map(([name,text])=>writeFile(join(directory,name),text)));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [before,after,out]=process.argv.slice(2);
  if(!before||!after||!out)throw new Error('Usage: node metrics-report.mjs before/run.json after/run.json output-directory');
  const result=compareRuns(JSON.parse(await readFile(before,'utf8')),JSON.parse(await readFile(after,'utf8')));
  await writeReports(out,result);console.log(resolve(out,'report.html'));
}
