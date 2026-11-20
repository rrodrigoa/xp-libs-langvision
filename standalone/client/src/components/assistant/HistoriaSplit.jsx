import { useEffect,useRef,useState } from 'react';
import { clampHistoriaSplit } from '../../../../shared/historiaLayout.js';

export function HistoriaSplit({children,...props}) {
  const host=useRef(null);
  const drag=useRef(null);
  const [ratio,setRatio]=useState(()=>{try {const saved=Number(localStorage.getItem('historia.split'));return saved>=20&&saved<=70?saved:35;}catch{return 35;}});
  useEffect(()=>{
    const observer=new ResizeObserver(()=>{if(host.current.clientWidth&&window.innerWidth>980)setRatio(current=>clampHistoriaSplit(current,host.current.clientWidth));});
    observer.observe(host.current);return()=>observer.disconnect();
  },[]);
  const update=value=>{const next=clampHistoriaSplit(value,host.current?.clientWidth);setRatio(next);try{localStorage.setItem('historia.split',String(next));}catch{/* Storage may be disabled. */}};
  return <div {...props} ref={host} style={{...props.style,'--historia-left':`${ratio}%`}}>
    {children[0]}
    <div className="historia-divider" role="separator" aria-label="Resize history panes" aria-orientation="vertical" aria-valuemin={20} aria-valuemax={70} aria-valuenow={Math.round(ratio)} tabIndex={0} data-testid="historia-divider"
      onPointerDown={event=>{if(event.button!==0)return;event.preventDefault();drag.current={x:event.clientX,ratio,width:host.current.clientWidth};event.currentTarget.setPointerCapture(event.pointerId);}}
      onPointerMove={event=>{if(drag.current&&event.currentTarget.hasPointerCapture(event.pointerId))update(drag.current.ratio+(event.clientX-drag.current.x)/drag.current.width*100);}}
      onPointerUp={event=>{drag.current=null;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}
      onLostPointerCapture={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}
      onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();update(event.key==='Home'?20:event.key==='End'?70:ratio+(event.key==='ArrowRight'?2:-2));}}}/>
    {children[1]}
  </div>;
}
