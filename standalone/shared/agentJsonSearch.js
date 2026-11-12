export function jsonSearchRanges(text, query) {
  if (!query) return [];
  const source=text.toLowerCase(),needle=query.toLowerCase(),ranges=[];
  for(let offset=source.indexOf(needle);offset>=0;offset=source.indexOf(needle,offset+Math.max(1,needle.length)))ranges.push({start:offset,end:offset+needle.length});
  return ranges;
}
export function jsonSearchableValue(key, value) {
  return `${key}\n${typeof value==='string'?value:JSON.stringify(value)}`;
}
export function localJsonMatches(value,query,basePath='') {
  const result=[],stack=[{value,path:basePath,key:'',root:true}],needle=query.toLowerCase();
  while(stack.length){const item=stack.pop(),object=item.value!==null&&typeof item.value==='object';
    if(!item.root&&(item.key.toLowerCase().includes(needle)||!object&&jsonSearchableValue('',item.value).toLowerCase().includes(needle)))result.push({...item,type:item.value===null?'null':Array.isArray(item.value)?'array':typeof item.value});
    if(object)for(const key of Object.keys(item.value).reverse())stack.push({key,value:item.value[key],path:`${item.path}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`});
  }
  return result;
}
