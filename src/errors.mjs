// Providers sometimes encode an error object inside the RPC message string.
// Keep the actionable message and avoid showing JSON wrappers in chat.
export function readableError(value){
 if(value==null)return undefined;
 let current=value;
 for(let depth=0;depth<4;depth++){
  if(typeof current==='string'){
   try{const parsed=JSON.parse(current);if(parsed&&typeof parsed==='object'){current=parsed;continue;}}catch{}
   return current;
  }
  if(current&&typeof current==='object'){current=current.error?.message||current.error||current.message;continue;}
  break;
 }
 return typeof current==='string'?current:'The task could not be completed.';
}
