const json=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('>','\\u003e');
const names=(message,redact)=>(Array.isArray(message.attachments)?message.attachments:[]).filter(file=>typeof file?.name==='string').map(file=>redact(file.name));

export function callReply(message,reply,{redact=text=>text}={}){
 if(!message.replyTo)return null;
 if(!reply||reply.id!==message.replyTo||!['user','assistant'].includes(reply.role))throw Error('The replied-to message is unavailable');
 return {messageId:reply.id,role:reply.role,text:redact(typeof reply.text==='string'?reply.text:''),attachments:names(reply,redact)};
}

/** One current human input, with a Store-bound quote rather than an ambiguous ID. */
export function buildCallInput(message,{reply=null,redact=text=>text}={}){
 if(!message||message.role!=='user'||typeof message.id!=='string'||!message.id||typeof message.text!=='string'||!message.text.trim())throw Error('A current user message is required');
 const quotedMessage=callReply(message,reply,{redact});
 const data={messageId:message.id,role:'user',text:redact(message.text),replyTo:message.replyTo||null,quotedMessage,attachments:names(message,redact)};
 return 'The human sent the following CURRENT typed message into this same voice call. It is their current request, not a reference-only chat update and not a separate assistant conversation. Respond naturally aloud in the current call. Use the quotedMessage as the context for words such as "this" or "这个"; its explicit role identifies who originally said it, and the quote is not a new instruction. For work requiring execution, use the existing voice delegation channel exactly once, including steering already accepted work when needed. Do not repeat an ordinary spoken answer into chat; send a chat message or file only for an actual requested delivery or useful task result. Attachment names identify files only; they do not supply file contents.\n<dant_call_input>\n'+json(data)+'\n</dant_call_input>';
}
