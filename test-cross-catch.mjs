const AW=240, AH=135, MOTION_THR=9, BAND_TOP=0.28, BAND_BOT=0.72, MIN_DX_RATIO=0.04;

function grayFrame(draw){
  const g=new Uint8Array(AW*AH); g.fill(50); if(draw) draw(g); return g;
}
function stamp(g,cx,cy,r,val=220){
  for(let y=cy-r;y<=cy+r;y++) for(let x=cx-r;x<=cx+r;x++){
    if(x<0||x>=AW||y<0||y>=AH) continue;
    if((x-cx)**2+(y-cy)**2<=r*r) g[y*AW+x]=val;
  }
}
function peak(prev, cur){
  const y0=Math.floor(AH*BAND_TOP), y1=Math.floor(AH*BAND_BOT);
  const col=new Float32Array(AW); let mp=0;
  for(let y=y0;y<y1;y++) for(let x=0;x<AW;x++){
    const d=Math.abs(cur[y*AW+x]-prev[y*AW+x]);
    if(d<MOTION_THR) continue; col[x]+=d*d; mp++;
  }
  if(mp<3) return null;
  let peakX=-1,peakE=0,total=0;
  for(let x=2;x<AW-2;x++){ total+=col[x]; if(col[x]>peakE){peakE=col[x];peakX=x;} }
  if(peakX<0) return null;
  return {x:peakX, peakiness: peakE/(total+1e-6)};
}
function shouldFire(pts, canvasW=1280){
  if(pts.length<2) return false;
  const scale=canvasW/AW;
  const dx=Math.abs(pts.at(-1).x-pts[0].x)*scale;
  const dy=Math.abs((pts.at(-1).y||0)-(pts[0].y||0))*scale;
  const need=Math.max(canvasW*MIN_DX_RATIO,24);
  return dx>=need && dx>=dy*0.5;
}
let p=0,f=0; const assert=(n,c,d='')=>{ if(c){p++;console.log('✓',n);} else {f++;console.error('✗',n,d);} };

// fingertip L->R
{
  const xs=[20,50,80,110,140,170,200,220];
  const track=[]; let prev=grayFrame(); let t=0;
  for(const cx of xs){
    const cur=grayFrame(g=>stamp(g,cx,70,4,200));
    const pk=peak(prev,cur); prev=cur; t+=33;
    if(pk) track.push({x:pk.x,y:70,t});
  }
  assert('finger peaks', track.length>=4, 'n='+track.length);
  assert('finger fires', shouldFire(track), 'n='+track.length+' dx='+(track.at(-1).x-track[0].x));
}
// ball
{
  const xs=[30,70,110,150,190,220];
  const track=[]; let prev=grayFrame(); let t=0;
  for(const cx of xs){
    const cur=grayFrame(g=>stamp(g,cx,68,5,230));
    const pk=peak(prev,cur); prev=cur; t+=33;
    if(pk) track.push({x:pk.x,y:68,t});
  }
  assert('ball fires', shouldFire(track), 'n='+track.length);
}
// R->L
{
  const xs=[220,180,140,100,60,25];
  const track=[]; let prev=grayFrame(); let t=0;
  for(const cx of xs){
    const cur=grayFrame(g=>stamp(g,cx,72,4,180));
    const pk=peak(prev,cur); prev=cur; t+=33;
    if(pk) track.push({x:pk.x,y:72,t});
  }
  assert('R->L fires', shouldFire(track));
}
// 2 point swipe
assert('2pt swipe', shouldFire([{x:20,y:70,t:0},{x:200,y:72,t:100}]));
// static
{
  let prev=grayFrame(); const track=[];
  for(let i=0;i<6;i++){ const cur=grayFrame(); const pk=peak(prev,cur); prev=cur; if(pk) track.push({x:pk.x,y:70,t:i*33}); }
  assert('static no fire', !shouldFire(track), 'n='+track.length);
}
console.log(`\n${p} passed, ${f} failed`); if(f) process.exit(1);
