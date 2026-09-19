import crypto from 'node:crypto';
import { normalizeText } from './domain.mjs';

export const PREVENTIVE_ANSWERS=['Conforme','Parcial','Não conforme','Não se aplica','Não verificado'];
export const PREVENTIVE_SEVERITIES=['Baixo','Médio','Alto','Crítico'];
export const ACTION_STATUSES=['Aberto','Em andamento','Concluído'];
export const ASSESSMENT_STATUSES=['Em andamento','Concluída','Arquivada'];

export const DEFAULT_PREVENTIVE_TEMPLATE = Object.freeze([
  ['Jornada e ponto','Controles de jornada, ajustes e exceções possuem procedimento e evidência?','Alto'],
  ['Banco de horas','Banco de horas/compensações possuem base documental e conferência periódica?','Alto'],
  ['Intervalos','Intervalos intrajornada e interjornada são controlados e exceções são tratadas?','Alto'],
  ['Remuneração','Salários, funções, comissões e critérios de pagamento possuem documentação consistente?','Alto'],
  ['Equiparação','Há revisão de funções, critérios salariais e possíveis paradigmas comparáveis?','Médio'],
  ['Prêmios e PLR','Prêmios, bônus e PLR possuem critérios, documentos e comunicação coerentes?','Médio'],
  ['Saúde e segurança','PGR/NR-1 e controles de SST aplicáveis estão atualizados e com evidências de execução?','Crítico'],
  ['EPI e treinamentos','Entrega de EPI, treinamentos e registros de segurança estão documentados?','Alto'],
  ['Afastamentos','Atestados, afastamentos e retornos possuem fluxo definido e acompanhamento documental?','Alto'],
  ['Teletrabalho','Teletrabalho/home office possui regras documentadas sobre jornada, equipamentos e despesas?','Médio'],
  ['Comunicações e equipamentos','Uso de celular pessoal, WhatsApp e equipamentos possui política clara e rastreável?','Médio'],
  ['Terceiros','Terceirizados, prestadores e PJs passam por análise de escopo e risco de subordinação?','Alto'],
  ['Desligamentos','Desligamentos e acordos são revisados com checklist e documentação de suporte?','Alto'],
  ['CCT/ACT e políticas','CCT, ACT, regulamentos internos e políticas relevantes são revisados periodicamente?','Alto'],
  ['Conduta e denúncias','Há canal e procedimento documentado para denúncias, assédio e conflitos?','Alto']
]);

export function makeDefaultPreventiveItems(){
  return DEFAULT_PREVENTIVE_TEMPLATE.map(([topic,question,severity])=>({id:`pitem_${crypto.randomUUID()}`,topic,question,severity,answer:'Não verificado',evidence:'',recommendation:'',owner:'',dueDate:null,actionStatus:'Aberto'}));
}

export function validateAssessment(input={}, clientIds=new Set(), current=null){
  const clientId=normalizeText(input.clientId ?? current?.clientId,100);
  if(!clientIds.has(clientId)) return {ok:false,error:'Cliente inválido para a auditoria preventiva.'};
  const title=normalizeText(input.title ?? current?.title,200);
  if(title.length<3) return {ok:false,error:'Título da auditoria preventiva é obrigatório.'};
  const referenceDate=input.referenceDate ? normalizeDate(input.referenceDate) : (current?.referenceDate||null);
  if(input.referenceDate && !referenceDate) return {ok:false,error:'Data de referência inválida.'};
  const status=ASSESSMENT_STATUSES.includes(input.status) ? input.status : (current?.status||'Em andamento');
  const itemsInput=Array.isArray(input.items)?input.items:(current?.items||[]);
  const items=[];
  for(const item of itemsInput){const v=validateItem(item);if(!v.ok)return v;items.push(v.value);}
  return {ok:true,value:{clientId,title,referenceDate,status,scope:normalizeText(input.scope ?? current?.scope,2000),items}};
}

export function validateItem(item={}){
  const topic=normalizeText(item.topic,120), question=normalizeText(item.question,500);
  if(topic.length<2||question.length<5)return {ok:false,error:'Item preventivo exige tema e pergunta.'};
  const answer=PREVENTIVE_ANSWERS.includes(item.answer)?item.answer:'Não verificado';
  const severity=PREVENTIVE_SEVERITIES.includes(item.severity)?item.severity:'Médio';
  const actionStatus=ACTION_STATUSES.includes(item.actionStatus)?item.actionStatus:'Aberto';
  const dueDate=item.dueDate?normalizeDate(item.dueDate):null;if(item.dueDate&&!dueDate)return {ok:false,error:'Prazo do plano de ação inválido.'};
  return {ok:true,value:{id:normalizeText(item.id,100)||`pitem_${crypto.randomUUID()}`,topic,question,answer,severity,evidence:normalizeText(item.evidence,3000),recommendation:normalizeText(item.recommendation,3000),owner:normalizeText(item.owner,160),dueDate,actionStatus}};
}

export function preventiveSummary(assessment,{now=new Date(),timeZone='America/Sao_Paulo'}={}){
  const items=assessment?.items||[];const applicable=items.filter(i=>i.answer!=='Não se aplica');
  const checked=applicable.filter(i=>i.answer!=='Não verificado');
  const findings=items.filter(i=>['Parcial','Não conforme'].includes(i.answer));
  const critical=findings.filter(i=>['Crítico','Alto'].includes(i.severity));
  const today=dateKey(now,timeZone);
  const overdueActions=findings.filter(i=>i.actionStatus!=='Concluído'&&i.dueDate&&dayDiff(today,i.dueDate)<0);
  const weights={Baixo:1,Médio:2,Alto:4,Crítico:6};
  const points=findings.reduce((n,i)=>n+weights[i.severity]*(i.answer==='Não conforme'?2:1),0);
  const max=Math.max(1,applicable.reduce((n,i)=>n+weights[i.severity]*2,0));
  const exposure=Math.min(100,Math.round(points/max*100));
  return {items:items.length,checked:checked.length,completionPercent:applicable.length?Math.round(checked.length/applicable.length*100):100,findings:findings.length,highPriorityFindings:critical.length,overdueActions:overdueActions.length,exposureIndex:exposure,priority:exposure>=50||critical.some(i=>i.severity==='Crítico'&&i.answer==='Não conforme')?'Crítica':exposure>=30?'Alta':exposure>=15?'Média':'Baixa',openActions:findings.filter(i=>i.actionStatus!=='Concluído').length};
}

function normalizeDate(value){const s=String(value||'').trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;return Number.isNaN(Date.parse(`${s}T00:00:00Z`))?null:s;}
function dateKey(date,timeZone){const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);const m=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${m.year}-${m.month}-${m.day}`;}
function dayDiff(a,b){return Math.round((Date.parse(`${b}T00:00:00Z`)-Date.parse(`${a}T00:00:00Z`))/86400000);}
