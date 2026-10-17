// Preserve ambiguous mutations until the user checks or explicitly submits again.
export function createMessageSubmissions({newId=()=>crypto.randomUUID()}={}) {
  let attempt=null,unknown=null;
  return {
    get unknown(){return unknown;},
    prepare(route,payload,{confirmResend=false}={}){
      if(unknown&&!confirmResend)throw Object.assign(new Error('Check the unconfirmed message before sending again'),{needsConfirmation:true});
      if(confirmResend){attempt=null;unknown=null;}
      const signature=JSON.stringify({route,payload});
      if(!attempt||attempt.signature!==signature)attempt={route,payload:structuredClone(payload),signature,clientMessageId:newId()};
      return attempt;
    },
    unconfirmed(value){unknown=value;},
    acknowledged(clientMessageId){if(unknown?.clientMessageId===clientMessageId)unknown=null;if(attempt?.clientMessageId===clientMessageId)attempt=null;},
    find(messages){return unknown&&(messages||[]).find(message=>message.clientMessageId===unknown.clientMessageId)||null;},
  };
}

// A disconnected renderer may only stop the exact call that it owned.
export function createCallStops(stop) {
  const pending=new Set();let running=null;
  return {
    get ids(){return [...pending];},
    get pending(){return pending.size>0;},
    add(callId){if(typeof callId==='string'&&callId)pending.add(callId);},
    flush(){
      if(running)return running;
      running=(async()=>{
        const errors=[];
        for(const callId of [...pending]){
          try{await stop(callId);pending.delete(callId);}
          catch(error){
            // An authoritative rejection of an old ID proves it cannot stop a new call.
            if(error.status===400&&/voice call changed/i.test(error.message))pending.delete(callId);
            else errors.push(error);
          }
        }
        return errors;
      })().finally(()=>running=null);
      return running;
    },
  };
}
