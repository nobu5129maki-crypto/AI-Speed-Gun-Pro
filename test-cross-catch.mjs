const AW=320,AH=180;
const FRAME_X0=0.10,FRAME_X1=0.90,FRAME_Y0=0.335,FRAME_Y1=0.665;
const MOTION_THR=14, MIN_MOTION_PIXELS=8, MAX_MOTION_PIXELS=780;
const MIN_RISE_PEAKINESS=0.08, MIN_RISE_ENERGY=160;
const SHAKE_SPREAD_Y=0.42, SHAKE_ROI_FRAC=0.20;
const WHITE_MEAN=145, WHITE_STD=32;
const MIN_GUIDE_SPAN=0.18, ZONE_RATIO=0.12;

function gray(fill, draw){
  const g=new Uint8Array(AW*AH);
  g.fill(fill);
  if(draw) draw(g);
  return g;
}
function stamp(g,cx,cy,r,v){
  for(let y=cy-r;y<=cy+r;y++) for(let x=cx-r;x<=cx+r;x++){
    if(x<0||x>=AW||y<0||y>=AH) continue;
    if((x-cx)**2+(y-cy)**2<=r*r) g[y*AW+x]=v;
  }
}
function peak(prev,cur){
  const x0=Math.floor(AW*FRAME_X0),x1=Math.ceil(AW*FRAME_X1);
  const y0=Math.floor(AH*FRAME_Y0),y1=Math.ceil(AH*FRAME_Y1);
  const roiW=x1-x0, roiH=y1-y0;
  let sumBg=0,sumBg2=0,nBg=0;
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const v=cur[y*AW+x]; sumBg+=v; sumBg2+=v*v; nBg++;
  }
  const meanBg=sumBg/Math.max(1,nBg);
  const stdBg=Math.sqrt(Math.max(0,sumBg2/Math.max(1,nBg)-meanBg*meanBg));
  const whiteWall=meanBg>=WHITE_MEAN && stdBg<=WHITE_STD;
  const brightScene=meanBg>=WHITE_MEAN-15;
  const thr=whiteWall?26:(brightScene?18:MOTION_THR);
  const minPeakiness=whiteWall?0.18:MIN_RISE_PEAKINESS;
  const minEnergy=whiteWall?360:MIN_RISE_ENERGY;
  const maxRoiFrac=whiteWall?0.09:SHAKE_ROI_FRAC;
  const maxMotion=whiteWall?420:MAX_MOTION_PIXELS;

  const obj=new Float32Array(AW);
  let mp=0,sumY=0,sumY2=0,sumW=0;
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++){
    const now=cur[y*AW+x], pr=prev[y*AW+x];
    const d=Math.abs(now-pr);
    if(d<thr) continue;
    mp++; sumW+=d; sumY+=y*d; sumY2+=y*y*d;
    let boost;
    if(whiteWall||brightScene){
      const contrast=Math.abs(now-meanBg);
      if(contrast<(whiteWall?16:12)) continue;
      boost=contrast>40?1.55:(contrast>24?1.25:0.7);
      boost*=(contrast>=Math.abs(pr-meanBg)?1.25:0.45);
    } else {
      if(now<=pr) continue;
      boost=now>100?1.3:(now>70?1.1:1.0);
    }
    obj[x]+=d*d*boost;
  }
  let activeCols=0; for(let x=x0;x<x1;x++) if(obj[x]>0) activeCols++;
  if(mp<MIN_MOTION_PIXELS||mp>maxMotion) return null;
  if(mp>roiW*roiH*maxRoiFrac) return null;
  if(sumW>0){
    const my=sumY/sumW;
    const sy=Math.sqrt(Math.max(0,sumY2/sumW-my*my));
    const lim=whiteWall?SHAKE_SPREAD_Y*0.78:SHAKE_SPREAD_Y;
    if(sy>roiH*lim) return null;
  }
  if(whiteWall && activeCols>roiW*0.28) return null;
  let peakX=-1,peakE=0,total=0;
  for(let x=x0;x<x1;x++){ total+=obj[x]; if(obj[x]>peakE){peakE=obj[x];peakX=x;} }
  if(peakE<minEnergy||total<=0) return null;
  if(peakE/(total+1e-6)<minPeakiness) return null;
  let halfW=0; const halfThr=peakE*0.35;
  for(let x=peakX;x>=x0 && obj[x]>=halfThr;x--) halfW++;
  for(let x=peakX+1;x<x1 && obj[x]>=halfThr;x++) halfW++;
  if(whiteWall && halfW>Math.max(14,roiW*0.12)) return null;
  return {x:peakX,y:(y0+y1)/2,whiteWall};
}
function crosses(pts){
  const left=AW*FRAME_X0,right=AW*FRAME_X1,w=right-left;
  const zL=left+w*ZONE_RATIO,zR=right-w*ZONE_RATIO;
  let L=false,R=false;
  for(const p of pts){ if(p.x<=zL)L=true; if(p.x>=zR)R=true; }
  if(L&&R) return true;
  return Math.abs(pts.at(-1).x-pts[0].x)>=w*MIN_GUIDE_SPAN;
}
function shouldFire(pts, whiteMode=false){
  if(pts.length<(whiteMode?4:3)) return false;
  if(!crosses(pts)) return false;
  const span=whiteMode?MIN_GUIDE_SPAN*1.45:MIN_GUIDE_SPAN;
  const dx=Math.abs(pts.at(-1).x-pts[0].x);
  return dx>=AW*(FRAME_X1-FRAME_X0)*span;
}
let p=0,f=0; const A=(n,c,d='')=>{if(c){p++;console.log('✓',n);}else{f++;console.error('✗',n,d);}};

{
  const xs=[40,70,100,130,160,190,220,250,270];
  const track=[]; let prev=gray(48); let t=0;
  for(const cx of xs){
    const cur=gray(48,g=>stamp(g,cx,Math.floor(AH*0.5),5,230));
    const pk=peak(prev,cur); prev=cur; t+=33; if(pk) track.push({...pk,t});
  }
  A('full in-frame cross fires', shouldFire(track), 'n='+track.length);
}
{
  const xs=[50,90,130,170,210,250];
  const track=[]; let prev=gray(48); let t=0;
  for(const cx of xs){
    const cur=gray(48,g=>stamp(g,cx,Math.floor(AH*0.5),3,95));
    const pk=peak(prev,cur); prev=cur; t+=33; if(pk) track.push({...pk,t});
  }
  A('dim fingertip-like cross fires', shouldFire(track), 'n='+track.length);
}
{
  // dark finger on white wall — should still measure
  const xs=[40,80,120,160,200,240,270];
  const track=[]; let prev=gray(210); let t=0;
  for(const cx of xs){
    const cur=gray(210,g=>stamp(g,cx,Math.floor(AH*0.5),4,70));
    const pk=peak(prev,cur); prev=cur; t+=33; if(pk) track.push({...pk,t,ww:1});
  }
  A('white-wall dark object cross fires', shouldFire(track,true), 'n='+track.length);
}
{
  // white wall micro shimmer — should NOT peak
  let prev=gray(210); let hits=0;
  for(let i=0;i<6;i++){
    const cur=gray(210,g=>{
      for(let y=Math.floor(AH*FRAME_Y0); y<Math.ceil(AH*FRAME_Y1); y++)
        for(let x=Math.floor(AW*FRAME_X0); x<Math.ceil(AW*FRAME_X1); x++)
          g[y*AW+x]=210+((x+y+i)%5===0?12:((x*3+y+i)%7===0?8:0));
    });
    if(peak(prev,cur)) hits++;
    prev=cur;
  }
  A('white-wall micro shimmer rejected', hits===0, 'hits='+hits);
}
{
  // white wall tiny local jitter track should not fire
  const track=[];
  for(let i=0;i<8;i++) track.push({x:160+Math.sin(i)*4, y:90, t:1000+i*33, ww:1});
  A('white-wall tiny travel rejected', !shouldFire(track,true));
}
{
  const track=[];
  for(let i=0;i<8;i++) track.push({x:160+Math.sin(i)*2, y:90, t:1000+i*33});
  A('tiny jitter rejected', !shouldFire(track));
}
{
  let prev=gray(48); let hits=0;
  for(const cx of [50,120,200]){
    const cur=gray(48,g=>stamp(g,cx,12,4,230));
    if(peak(prev,cur)) hits++; prev=cur;
  }
  A('outside frame ignored', hits===0, 'hits='+hits);
}
{
  let prev=gray(48);
  const cur=gray(49);
  A('weak flat motion no peak', peak(prev,cur)==null);
}
{
  let prev=gray(48);
  const cur=gray(48,g=>{
    for(let y=Math.floor(AH*FRAME_Y0); y<Math.ceil(AH*FRAME_Y1); y++)
      for(let x=Math.floor(AW*FRAME_X0); x<Math.ceil(AW*FRAME_X1); x++)
        g[y*AW+x]=48+((x+y)%3===0?22:8);
  });
  A('handshake-like spread rejected', peak(prev,cur)==null);
}

console.log(`\n${p} passed, ${f} failed`); if(f) process.exit(1);
