import assert from 'node:assert/strict';
import {parseAst} from 'rollup/parseAst';
import postcss from 'postcss';

const programs=new Map();
function program(source){
 if(!programs.has(source)){if(programs.size>=16)programs.delete(programs.keys().next().value);programs.set(source,parseAst(source));}
 return programs.get(source);
}
function markerIdentity(marker){
 assert.equal(typeof marker,'string','A source fixture marker must be text');
 const declaration=/^(?:async\s+)?function\s+([\w$]+)\b|^(?:const|let|var)\s+([\w$]+)\b/.exec(marker.trim());
 if(declaration)return {kind:'declaration',name:declaration[1]||declaration[2]};
 const listener=/^document\.addEventListener\(\s*['"]([^'"]+)/.exec(marker.trim());
 if(listener)return {kind:'listener',name:listener[1]};
 throw Error('Unsupported source fixture marker: '+marker);
}
function matches(node,identity){
 if(node.type==='ExportNamedDeclaration')node=node.declaration;
 if(!node)return false;
 if(identity.kind==='declaration')return node.type==='FunctionDeclaration'&&node.id?.name===identity.name||node.type==='VariableDeclaration'&&node.declarations.some(value=>value.id?.type==='Identifier'&&value.id.name===identity.name);
 const call=node.type==='ExpressionStatement'?node.expression:null;
 return call?.type==='CallExpression'&&call.callee?.type==='MemberExpression'&&call.callee.object?.name==='document'&&call.callee.property?.name==='addEventListener'&&call.arguments[0]?.value===identity.name;
}
export function sourceIndex(source,marker,after=0){
 const identity=markerIdentity(marker),nodes=program(source).body.filter(node=>node.start>=after&&matches(node,identity));
 assert.equal(nodes.length,1,`Expected exactly one ${identity.kind} named ${identity.name} after ${after}`);
 return nodes[0].start;
}
export function sourceSection(source,start,end){
 const first=sourceIndex(source,start),last=sourceIndex(source,end,first+1);
 assert.ok(last>first,'Source fixture declarations must remain in order');return source.slice(first,last);
}
export function sourceDeclaration(source,marker){
 const start=sourceIndex(source,marker),node=program(source).body.find(node=>node.start===start);
 return source.slice(node.start,node.end);
}
function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(child=>walk(child,visit));else if(value&&typeof value==='object')walk(value,visit);}
function calleeName(node){if(node?.type==='Identifier')return node.name;if(node?.type==='CallExpression')return calleeName(node.callee);if(node?.type==='MemberExpression')return calleeName(node.object)+'.'+(node.property.name||node.property.value);return '';}
function expressionStatement(source,predicate){
 const nodes=[];walk(program(source),node=>{if(node.type==='ExpressionStatement'&&predicate(node.expression))nodes.push(node);});
 assert.equal(nodes.length,1,'Expected one exact expression statement for this fixture');return source.slice(nodes[0].start,nodes[0].end);
}
export function sourceCallStatement(source,name){return expressionStatement(source,node=>node.type==='CallExpression'&&calleeName(node.callee)===name);}
export function sourceSelectorBinding(source,selector){
 return expressionStatement(source,node=>{
  if(node.type!=='CallExpression'||calleeName(node.callee)!=='document.querySelectorAll.forEach')return false;
  const query=node.callee.object;return query?.type==='CallExpression'&&query.arguments[0]?.value===selector;
 });
}
export function compactCss(source){
 // Formatting is normalized only in the assertion view. Production CSS stays
 // readable, and the original declarations and selectors are still checked.
 const compact=value=>{
  const strings=[];
  const protectedText=value.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,text=>`\u0000${strings.push(text)-1}\u0000`);
  return protectedText.replace(/\s+/g,' ').replace(/\s*([,:>~])\s*/g,'$1').trim().replace(/\u0000(\d+)\u0000/g,(_match,index)=>strings[Number(index)]);
 };
 const children=node=>(node.nodes||[]).filter(node=>node.type!=='comment').map(render).join('').replace(/;$/,'');
 const render=node=>{
  if(node.type==='decl')return node.prop+':'+compact(node.value)+(node.important?'!important':'')+';';
  if(node.type==='rule')return compact(node.selector)+'{'+children(node)+'}';
  if(node.type==='atrule'){const params=compact(node.params||''),prefix='@'+node.name+(params?(params.startsWith('(')?'':' ')+params:'');return node.nodes?prefix+'{'+children(node)+'}':prefix+';';}
  throw Error('Unexpected CSS fixture node: '+node.type);
 };
 return children(postcss.parse(source))+'\n';
}
