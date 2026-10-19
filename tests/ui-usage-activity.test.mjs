import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {buildUsageActivity,createUsageActivityController,renderUsageActivity} from '../ui/usage-activity.js';
import {renderUsageSettings} from '../ui/usage-settings.js';

const now=Date.parse('2026-10-18T16:15:00Z'); // Already Oct 19 in the persisted history zone.
const counts=(input,output=0)=>({inputTokens:input,cachedInputTokens:input,outputTokens:output,reasoningOutputTokens:output,totalTokens:input+output});
const usage={recordedSince:now,subscription:{available:true,totals:counts(1000000000,20),lastResponse:{...counts(20),at:now}},apiVoice:{available:true,totals:counts(150),lastResponse:{...counts(50),at:now}},activity:{timeZone:'Asia/Kuala_Lumpur',recordedSince:now,retainedFrom:'2025-09-15',days:[{date:'2026-10-15',subscription:counts(10,5),apiVoice:counts(50)},{date:'2026-10-16',subscription:counts(20,10),apiVoice:null},{date:'2026-10-17',subscription:null,apiVoice:counts(100)},{date:'2026-10-18',subscription:counts(0),apiVoice:null},{date:'2026-10-19',subscription:counts(40,10),apiVoice:null}],unallocated:{subscription:counts(999999925),apiVoice:null}}};
const dom=html=>parseHTML(`<html><body>${html}</body></html>`);

test('activity uses dated input plus output exactly once and preserves unknown days and provider separation',()=>{
 const model=buildUsageActivity({usage,now});
 assert.equal(model.timeZone,'Asia/Kuala_Lumpur');assert.equal(new Date(model.today).toISOString().slice(0,10),'2026-10-19');assert.equal(model.dates.length,365);
 assert.equal(model.dates.find(day=>day.date==='2026-10-15').value,15);
 assert.equal(model.dates.find(day=>day.date==='2026-10-17').value,null);
 assert.equal(model.dates.find(day=>day.date==='2026-10-18').value,0);
 assert.equal(model.lifetime,1000000020);assert.equal(model.peak,50);assert.equal(model.longest,2);assert.equal(model.current,1);assert.equal(model.hasUndated,true);
 assert.equal(model.cumulative.at(-1).total,95);assert.equal(model.weeks.find(week=>week.date==='2026-10-12').value,45);assert.equal(model.weeks.at(-1).value,50);
 const voice=buildUsageActivity({usage,provider:'apiVoice',now});assert.equal(voice.cumulative.at(-1).total,150);assert.equal(voice.dates.at(-1).value,null);assert.equal(voice.current,0);
});

test('current streak may end yesterday, but never crosses an unknown or zero day',()=>{
 const history=days=>({...usage,activity:{...usage.activity,days:days.map(([date,total])=>({date,subscription:counts(total)}))}});
 assert.equal(buildUsageActivity({usage:history([['2026-10-17',1],['2026-10-18',2]]),now}).current,2);
 assert.equal(buildUsageActivity({usage:history([['2026-10-16',1],['2026-10-18',2]]),now}).current,1);
 assert.equal(buildUsageActivity({usage:history([['2026-10-17',1],['2026-10-18',0]]),now}).current,0);
});

test('earlier totals are never fabricated into a daily bucket and future, invalid, duplicate and outside dates are ignored',()=>{
 const legacy={subscription:{available:true,totals:counts(9000000)}};
 const model=buildUsageActivity({usage:legacy,now});assert.equal(model.known.length,0);assert.equal(model.peak,null);assert.equal(model.longest,null);assert.equal(model.lifetime,9000000);
 const invalid={...usage,activity:{...usage.activity,timeZone:'<invalid>',days:[{date:'2026-02-30',subscription:counts(1)},{date:'2026-10-20',subscription:counts(2)},{date:'2025-01-01',subscription:counts(3)},{date:'2026-10-18',subscription:counts(4)},{date:'2026-10-18',subscription:counts(5)},{date:'2026-10-17',subscription:counts(Number.MAX_SAFE_INTEGER,1)},{date:'2026-10-16',subscription:counts(-1)}]}};
 const checked=buildUsageActivity({usage:invalid,now});assert.equal(checked.timeZone,'UTC');assert.equal(checked.known.length,1);assert.equal(checked.known[0].value,4);
 for(const language of ['en','zh']){const {document}=dom(renderUsageSettings({usage:legacy,language,now}));assert.equal(document.querySelectorAll('[data-usage-level="unknown"][data-usage-point]').length,365);assert.match(document.body.textContent,language==='zh'?/旧的累计用量不会分配到日期/:/Earlier totals are not assigned to dates/);assert.equal(document.querySelector('[data-usage-stat="peak"]').textContent,'—');}
});

test('daily calendar is compact, labelled and keyboard reachable without 365 tab stops',()=>{
 const {document}=dom(renderUsageSettings({usage,now}));
 assert.equal(document.querySelectorAll('[data-usage-point]').length,365);assert.equal(document.querySelectorAll('[data-usage-point][tabindex="0"]').length,1);
 const zero=document.querySelector('[data-usage-date="2026-10-18"]'),missing=document.querySelector('[data-usage-date="2026-10-17"]');
 assert.equal(zero.dataset.usageLevel,'0');assert.match(zero.title,/0 tokens/);assert.equal(missing.dataset.usageLevel,'unknown');assert.match(missing.title,/No report/);
 assert.equal(document.querySelector('[data-usage-stat="lifetime"]').getAttribute('title'),'1,000,000,020 tokens');assert.match(document.body.textContent,/Earlier or undated/);
 assert.equal(document.querySelector('[data-usage-details]').hasAttribute('open'),false);
});

test('weekly bars and cumulative points show only accurately dated records with exact tooltips',()=>{
 const weekly=dom(renderUsageActivity({usage,now,mode:'weekly'})).document;
 assert.ok(weekly.querySelectorAll('.usage-week-bar').length>=52);assert.match(weekly.querySelector('[data-usage-date="2026-10-12"]').getAttribute('aria-label'),/45 tokens · 3 reported days/);
 const cumulative=dom(renderUsageActivity({usage,now,mode:'cumulative'})).document;
 assert.equal(cumulative.querySelectorAll('[data-usage-point]').length,4);assert.match(cumulative.querySelector('[data-usage-point]:last-child').getAttribute('aria-label'),/Recorded 95 tokens/);assert.ok(cumulative.querySelector('.usage-cumulative-line'));assert.doesNotMatch(cumulative.querySelector('svg').textContent,/1,000,000,020/);
 const empty=dom(renderUsageActivity({now,mode:'cumulative'})).document;assert.equal(empty.querySelectorAll('[data-usage-point]').length,0);assert.equal(empty.querySelectorAll('.usage-cumulative-line').length,0);
});

test('controller preserves mode, provider and detail disclosure through state rerenders and binds each root once',()=>{
 const {document,Event}=dom('');let renders=0,controller;
 const render=()=>{renders++;document.body.innerHTML=renderUsageSettings({usage,now,...controller.state});controller.bind();controller.bind();};
 controller=createUsageActivityController({document,onChange:render});controller.bind();render();
 document.querySelector('[data-usage-mode="weekly"]').click();assert.equal(controller.state.mode,'weekly');assert.equal(renders,2);assert.ok(document.querySelector('.usage-week-bar'));
 document.querySelector('[data-usage-source="apiVoice"]').click();assert.equal(controller.state.provider,'apiVoice');assert.equal(renders,3);assert.match(document.querySelector('[data-usage-date="2026-10-12"]').getAttribute('aria-label'),/150 tokens/);
 const details=document.querySelector('[data-usage-details]');details.open=true;details.dispatchEvent(new Event('toggle'));render();assert.equal(document.querySelector('[data-usage-details]').hasAttribute('open'),true);
 document.querySelector('[data-usage-mode="daily"]').click();assert.equal(controller.state.mode,'daily');assert.equal(controller.state.provider,'apiVoice');
 const points=[...document.querySelectorAll('[data-usage-point]')],point=points.at(-1),key=new Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(key,'key',{value:'ArrowLeft'});point.dispatchEvent(key);
 assert.equal(key.defaultPrevented,true);assert.equal(points.at(-8).getAttribute('tabindex'),'0');assert.equal(document.querySelectorAll('[data-usage-point][tabindex="0"]').length,1);assert.match(document.querySelector('[data-usage-tooltip]').textContent,/Oct 12, 2026/);
 points[5].dispatchEvent(new Event('pointerover',{bubbles:true}));assert.equal(document.querySelector('[data-usage-tooltip]').textContent,points[5].dataset.usageLabel);
});

test('unknown providers and modes fall back safely and localized labels escape untrusted history strings',()=>{
 for(const language of ['zh','en']){const {document}=dom(renderUsageSettings({usage,now,language,provider:'bad',mode:'bad'}));assert.equal(document.querySelector('[data-usage-source="subscription"]').getAttribute('aria-pressed'),'true');assert.equal(document.querySelector('[data-usage-mode="daily"]').getAttribute('aria-pressed'),'true');assert.match(document.body.textContent,language==='zh'?/单日最高 Token/:/Peak daily tokens/);assert.match(document.body.textContent,language==='zh'?/不代表用量为 0/:/unknown, not zero/);}
});
