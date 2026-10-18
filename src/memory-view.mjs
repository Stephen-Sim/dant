import {DANT_IDENTITY_INSTRUCTIONS} from './identity.mjs';

// These are the same public identity and durable references supplied to text
// and voice. Runtime instructions, credentials and MCP configuration stay out.
export function currentMemoryView(engine){
 return {conversationId:engine.store.state.conversationId,readOnly:true,identity:{text:DANT_IDENTITY_INSTRUCTIONS},memory:{text:engine.redact(engine.memory.context())}};
}

export function installMemoryViewRoutes(app,engine){
 app.get('/api/memory/view',(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  try{res.json(currentMemoryView(engine));}catch{res.status(503).json({error:'The current memory could not be read. Try again after reconnecting.'});}
 });
 app.all('/api/memory/view',(req,res)=>res.status(405).json({error:'This memory view is read-only.'}));
}
