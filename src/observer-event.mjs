/**
 * Codex has already consumed MCP images. Its application observer needs tool
 * identity, status and delivery markers, not a second retained base64 copy.
 * Copy only the image-bearing path; never change the original model result,
 * text content, arguments or structured delivery metadata.
 */
export function prepareObserverEvent(event){
 const item=event?.params?.item,content=item?.result?.content;
 if(item?.type!=='mcpToolCall'||!Array.isArray(content))return event;
 let changed=false;
 const observed=content.map(block=>{
  if(block?.type!=='image'||typeof block.data!=='string')return block;
  changed=true;const {data,...metadata}=block;return metadata;
 });
 return changed?{...event,params:{...event.params,item:{...item,result:{...item.result,content:observed}}}}:event;
}
