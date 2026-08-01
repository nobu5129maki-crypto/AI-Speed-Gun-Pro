const AW=320,AH=180;
const FRAME_X0=0.10,FRAME_X1=0.90,FRAME_Y0=0.335,FRAME_Y1=0.665;
const MOTION_THR=14, MIN_MOTION_PIXELS=8, MAX_MOTION_PIXELS=780;
const MIN_RISE_PEAKINESS=0.08, MIN_RISE_ENERGY=160;
const SHAKE_SPREAD_Y=0.42, SHAKE_ROI_FRAC=0.20;
const MIN_GUIDE_SPAN=0.18, ZONE_RATIO=0.12;

function gray(draw){const g=new Uint8Array(AW*AH); g.fill(48); if(draw) draw(g); return g;}
function stamp(g,cx,cy,r,v=220){
  for(let y=cy-r;y<=cy+r;y++) for(let x=cx-r;x<=cx+r;x++){
    if(x<0||x>=AW||y<0||y>=AH) continue;
    if((x-cx)**2+(y-cy)**2<=r*r) g[y*AW+x]=v;
  }
}
function peak(prev,cur){
  const x0=Math.floor(AW*FRAME_X0),x1=Math.ceil(AW*FRAME_X1);
  const y0=Math.floor(AH*FRAME_Y0),y1=Math.ceil(AH*FRAME_Y1);
  const rise=new Float32Array(AW);
  let mp=0,sumY=0,sumY2=0,sumW=0;
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const now=cur[y*AW+x], pr=prev[y*AW+x];
    const d=Math.abs(now-pr);
    if(d<MOTION_THR) continue;
    mp++; sumW+=d; sumY+=y*d; sumY2+=y*y*d;
    if(now<=pr) continue;
    const bright=now>100?1.3:(now>70?1.1:1.0);
    rise[x]+=d*d*bright;
  }
  const roiW=x1-x0, roiH=y1-y0;
  if(mp<MIN_MOTION_PIXELS||mp>MAX_MOTION_PIXELS) return null;
  if(mp>roiW*roiH*SHAKE_ROI_FRAC) return null;
  if(sumW>0){
    const my=sumY/sumW;
    const sy=Math.sqrt(Math.max(0,sumY2/sumW-my*my));
    if(sy>roiH*SHAKE_SPREAD_Y) return null;
  }
  let peakX=-1,peakE=0,total=0;
  for(let x=x0;x<x1;x++){ total+=rise[x]; if(rise[x]>peakE){peakE=rise[x];peakX=x;} }
  if(peakE<MIN_RISE_ENERGY||total<=0) return null;
  if(peakE/(total+1e-6)<MIN_RISE_PEAKINESS) return null;
  return {x:peakX,y:(y0+y1)/2};
}
function crosses(pts){
  const left=AW*FRAME_X0,right=AW*FRAME_X1,w=right-left;
  const zL=left+w*ZONE_RATIO,zR=right-w*ZONE_RATIO;
  let L=false,R=false;
  for(const p of pts){ if(p.x<=zL)L=true; if(p.x>=zR)R=true; }
  if(L&&R) return true;
  return Math.abs(pts.at(-1).x-pts[0].x)>=w*MIN_GUIDE_SPAN;
}
function shouldFire(pts){
  if(pts.length<3) return false;
  if(!crosses(pts)) return false;
  const dx=Math.abs(pts.at(-1).x-pts[0].x);
  return dx>=AW*(FRAME_X1-FRAME_X0)*MIN_GUIDE_SPAN;
}
let p=0,f=0; const A=(n,c,d='')=>{if(c){p++;console.log('✓',n);}else{f++;console.error('✗',n,d);}};

{
  const xs=[40,70,100,130,160,190,220,250,270];
  const track=[]; let prev=gray(); let t=0;
  for(const cx of xs){
    const cur=gray(g=>stamp(g,cx,Math.floor(AH*0.5),5,230));
    const pk=peak(prev,cur); prev=cur; t+=33; if(pk) track.push({...pk,t});
  }
  A('full in-frame cross fires', shouldFire(track), 'n='+track.length);
}
{
  const xs=[100,130,160,190,220];
  const track=[]; let prev=gray(); let t=0;
  for(const cx of xs){
    const cur=gray(g=>stamp(g,cx,Math.floor(AH*0.5),4,210));
    const pk=peak(prev,cur); prev=cur; t+=33; if(pk) track.push({...pk,t});
  }
  A('mid-span pass fires', shouldFire(track), 'n='+track.length);
}
{
  // fingertip-like dim small blob
  const xs=[50,90,130,170,210,250];
  const track=[]; let prev=gray(); let t=0;
  for(const cx of xs){
    const cur=gray(g=>stamp(g,cx,Math.floor(AH*0.5),3,95));
    const pk=peak(prev,cur); prev=cur; t+=33; if(pk) track.push({...pk,t});
  }
  A('dim fingertip-like cross fires', shouldFire(track), 'n='+track.length);
}
{
  const track=[];
  for(let i=0;i<8;i++) track.push({x:160+Math.sin(i)*2, y:90, t:1000+i*33});
  A('tiny jitter rejected', !shouldFire(track));
}
{
  const track=[{x:40,y:90,t:0},{x:55,y:91,t:33},{x:70,y:90,t:66}];
  A('partial left travel rejected', !shouldFire(track));
}
{
  let prev=gray(); let hits=0;
  for(const cx of [50,120,200]){
    const cur=gray(g=>stamp(g,cx,12,4,230));
    if(peak(prev,cur)) hits++; prev=cur;
  }
  A('outside frame ignored', hits===0, 'hits='+hits);
}
{
  let prev=gray();
  const cur=gray(g=>{ for(let i=0;i<g.length;i++) g[i]=49; });
  A('weak flat motion no peak', peak(prev,cur)==null);
}
{
  let prev=gray();
  const cur=gray(g=>{
    for(let y=Math.floor(AH*FRAME_Y0); y<Math.ceil(AH*FRAME_Y1); y++)
      for(let x=Math.floor(AW*FRAME_X0); x<Math.ceil(AW*FRAME_X1); x++)
        g[y*AW+x]=48+((x+y)%3===0?22:8);
  });
  A('handshake-like spread rejected', peak(prev,cur)==null);
}

console.log(`\n${p} passed, ${f} failed`); if(f) process.exit(1);
