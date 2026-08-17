import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.3.0/dist/maplibre-gl.mjs';
import {CLUSTER_ORDER,CLUSTERS} from './photo-modes-v13-data.js';

const $=id=>document.getElementById(id);
const photoButton=$('photoBtn');
const nativeSetAttribute=photoButton.setAttribute.bind(photoButton);
const nativeRemoveAttribute=photoButton.removeAttribute.bind(photoButton);

// Never allow Safari's native disabled state to become sticky.
nativeRemoveAttribute('disabled');
Object.defineProperty(photoButton,'disabled',{configurable:true,get(){return false},set(value){photoButton.dataset.requestedDisabled=String(Boolean(value));nativeRemoveAttribute('disabled')}});
photoButton.setAttribute=function(name,value){
  if(name==='disabled'){nativeRemoveAttribute('disabled');return}
  if(name==='aria-disabled'){photoButton.dataset.baseAriaDisabled=String(value);return}
  return nativeSetAttribute(name,value)
};

let map=null;
const originalOn=maplibregl.Map.prototype.on;
maplibregl.Map.prototype.on=function(...args){map=this;return originalOn.apply(this,args)};

// Starts the established World → Cluster → POV app and keeps the v15 turn-during-lift fix.
await import('./photo-modes-v15-turn-app.js');

const canvas=$('photoCanvas');
const ctx=canvas.getContext('2d');
const povButton=$('pov');
const poseChip=$('pose');
const note=$('note');
const clusterButtonIds={flatiron:'cluster-flatiron',noho:'cluster-noho',central:'cluster-central'};
const rects={
 '1300':[0,0,.2,.25],'1303':[.2,0,.2,.25],'1304':[.4,0,.2,.25],'1311':[.6,0,.2,.25],'1313':[.8,0,.2,.25],
 '1314':[0,.25,.2,.25],'1315':[.2,.25,.2,.25],'1317':[.4,.25,.2,.25],'1320':[.6,.25,.2,.25],'1322':[.8,.25,.2,.25],
 '1323':[0,.5,.2,.25],'1308':[0,.75,.355,.25]
};
const atlasChunkUrls=['./assets-v16/atlas-00.b64','./assets-v16/atlas-01.b64','./assets-v16/atlas-02.b64'];
let atlasImage=null,atlasObjectUrl=null,atlasError=null,photoVisible=false,photoLoading=false,selectedPhotoId=null,loadToken=0,syncQueued=false;
const worldMarkers=new Map(),microMarkers=new Map();

function inPov(){return povButton.classList.contains('active')||/^POV\b/.test(poseChip.textContent||'')}
function activeClusterId(){return Object.entries(clusterButtonIds).find(([,id])=>$(id)?.classList.contains('active'))?.[0]||null}
function currentSelection(){
  const cid=activeClusterId();if(!cid||!CLUSTERS[cid])return null;
  const dots=[...document.querySelectorAll('#dots .dot')];let i=dots.findIndex(d=>d.classList.contains('active'));if(i<0)i=0;
  return CLUSTERS[cid].observations[Math.min(i,CLUSTERS[cid].observations.length-1)]||null
}

async function decodeAtlas(){
  const chunks=await Promise.all(atlasChunkUrls.map(async url=>{const response=await fetch(url,{cache:'force-cache'});if(!response.ok)throw new Error(`${url} returned ${response.status}`);return response.text()}));
  const base64=chunks.join('').replace(/[^A-Za-z0-9+/=]/g,'');
  if(base64.length<1000)throw new Error('Atlas chunks were empty or incomplete.');
  const binary=atob(base64);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  const blob=new Blob([bytes],{type:'image/jpeg'});atlasObjectUrl=URL.createObjectURL(blob);
  const image=new Image();image.decoding='async';
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('The reconstructed JPEG atlas could not be decoded.'));image.src=atlasObjectUrl});
  atlasImage=image;drawAllMosaics();syncUi();return image
}
const atlasPromise=decodeAtlas().catch(error=>{atlasError=error;note.textContent=`Photo transport failed: ${error.message}`;syncUi();throw error});
atlasPromise.catch(()=>{});

function cropCover(sw,sh,dw,dh){const sa=sw/sh,da=dw/dh;if(sa>da){const w=sh*da;return{x:(sw-w)/2,y:0,w,h:sh}}const h=sw/da;return{x:0,y:(sh-h)/2,w:sw,h}}
function drawCell(target,id){
  if(!atlasImage||!rects[String(id)])return false;const [u,v,wf,hf]=rects[String(id)];
  const sx=u*atlasImage.naturalWidth,sy=v*atlasImage.naturalHeight,sw=wf*atlasImage.naturalWidth,sh=hf*atlasImage.naturalHeight;
  const targetCtx=target.getContext('2d');if(!targetCtx)return false;const crop=cropCover(sw,sh,target.width,target.height);
  targetCtx.clearRect(0,0,target.width,target.height);targetCtx.drawImage(atlasImage,sx+crop.x,sy+crop.y,crop.w,crop.h,0,0,target.width,target.height);return true
}
function sizeCanvas(){const ratio=Math.min(window.devicePixelRatio||1,2),w=Math.max(1,Math.round(canvas.clientWidth*ratio)),h=Math.max(1,Math.round(canvas.clientHeight*ratio));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}}
function drawFullPhoto(id){
  if(!atlasImage||!rects[String(id)]||!ctx)throw new Error(`No decoded photo exists for observation ${id}.`);sizeCanvas();
  const [u,v,wf,hf]=rects[String(id)],sx=u*atlasImage.naturalWidth,sy=v*atlasImage.naturalHeight,sw=wf*atlasImage.naturalWidth,sh=hf*atlasImage.naturalHeight,crop=cropCover(sw,sh,canvas.width,canvas.height);
  ctx.fillStyle='#05070a';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(atlasImage,sx+crop.x,sy+crop.y,crop.w,crop.h,0,0,canvas.width,canvas.height)
}
function hidePhoto(copy=false){++loadToken;photoVisible=false;photoLoading=false;canvas.classList.remove('visible');document.body.classList.remove('photo-visible');photoButton.classList.remove('active','loading');if(copy&&inPov())note.textContent='Reconstructed POV · Photo is the same-perspective evidence toggle.';setTimeout(()=>{if(!photoVisible&&ctx)ctx.clearRect(0,0,canvas.width,canvas.height)},520);syncUi()}
async function showPhoto(){
  if(!inPov()){note.textContent='Enter POV first; Photo is the same-perspective evidence toggle.';return}
  const observation=currentSelection();if(!observation){note.textContent='No selected photograph is available.';return}
  const token=++loadToken;photoLoading=true;note.textContent='Reconstructing the photograph from local atlas chunks…';syncUi();
  try{await atlasPromise;if(token!==loadToken||!inPov())return;const latest=currentSelection();if(!latest||String(latest.id)!==String(observation.id))return;drawFullPhoto(observation.id);selectedPhotoId=String(observation.id);photoVisible=true;photoLoading=false;canvas.classList.add('visible');document.body.classList.add('photo-visible');note.textContent='Actual photograph · tap Photo again to return to the reconstructed POV.'}
  catch(error){photoLoading=false;photoVisible=false;note.textContent=`Photo failed: ${error.message}`}
  syncUi()
}

function layoutClass(count){return count<=1?'layout-1':count===2?'layout-2':count===3?'layout-3':'layout-plus'}
function averageCoordinate(observations){return[observations.reduce((s,o)=>s+o.coord[0],0)/observations.length,observations.reduce((s,o)=>s+o.coord[1],0)/observations.length]}
function markerGroups(){
  const n=CLUSTERS.noho.observations;
  return{
    flatiron:[{label:'Flatiron',obs:CLUSTERS.flatiron.observations}],
    noho:[
      {label:'Houston St',obs:n.filter(o=>o.id==='1303')},
      {label:'Bond St',obs:n.filter(o=>['1320','1322'].includes(String(o.id)))},
      {label:'Nolita',obs:n.filter(o=>['1304','1308','1311'].includes(String(o.id)))},
      {label:'Garden',obs:n.filter(o=>['1313','1314','1315','1317'].includes(String(o.id)))}
    ],
    central:[{label:'Boathouse',obs:CLUSTERS.central.observations}]
  }
}
function createMarker(label,observations,center,micro,onClick){
  const root=document.createElement('div');root.className='photoMarkerRoot'+(micro?' micro':'');
  const card=document.createElement('button');card.type='button';card.className='photoMarkerCard hidden';
  const mosaic=document.createElement('span');mosaic.className='mosaic '+layoutClass(observations.length);const visible=Math.min(observations.length,observations.length>3?3:observations.length);const canvases=[];
  observations.slice(0,visible).forEach(o=>{const c=document.createElement('canvas');c.width=micro?96:128;c.height=micro?72:96;c.dataset.obs=String(o.id);mosaic.appendChild(c);canvases.push(c)});
  if(observations.length>3){const badge=document.createElement('span');badge.className='moreBadge';badge.textContent=`+${observations.length-visible}`;mosaic.appendChild(badge)}
  const text=document.createElement('span');text.className='markerLabel';text.innerHTML=`<b>${label}</b><small>${observations.length} photo${observations.length===1?'':'s'}</small>`;card.append(mosaic,text);root.append(card);card.onclick=event=>{event.preventDefault();event.stopPropagation();onClick()};
  const marker=new maplibregl.Marker({element:root,anchor:'bottom',offset:[0,-6]}).setLngLat(center).addTo(map);const entry={card,canvases,observations};atlasPromise.then(()=>drawMosaic(entry)).catch(()=>card.classList.add('atlas-failed'));return entry
}
function drawMosaic(entry){entry.canvases.forEach(c=>drawCell(c,c.dataset.obs))}
function drawAllMosaics(){document.querySelectorAll('.photoMarkerCard canvas[data-obs]').forEach(c=>drawCell(c,c.dataset.obs))}
function createMarkers(){
  if(!map||worldMarkers.size)return;
  CLUSTER_ORDER.forEach(cid=>{const c=CLUSTERS[cid];worldMarkers.set(cid,createMarker(c.name,c.observations,c.center,false,()=>$(clusterButtonIds[cid])?.click()))});
  const groups=markerGroups();CLUSTER_ORDER.forEach(cid=>{const list=groups[cid].filter(g=>g.obs.length).map(group=>createMarker(group.label,group.obs,averageCoordinate(group.obs),true,()=>{const index=CLUSTERS[cid].observations.findIndex(o=>String(o.id)===String(group.obs[0].id));$(clusterButtonIds[cid])?.click();setTimeout(()=>document.querySelectorAll('#dots .dot')[index]?.click(),80)}));microMarkers.set(cid,list)});
  syncMarkers()
}
function syncMarkers(){
  const world=$('world')?.classList.contains('active'),cluster=$('clusterMode')?.classList.contains('active'),pose=poseChip.textContent||'',transit=/TRANSIT|AREA/.test(pose),cid=activeClusterId(),selection=currentSelection();
  worldMarkers.forEach((entry,id)=>{entry.card.className='photoMarkerCard '+(world?'world':transit?'transit':'hidden')+(cid===id?' active':'')});
  microMarkers.forEach((list,id)=>list.forEach(entry=>{const isActive=selection&&entry.observations.some(o=>String(o.id)===String(selection.id));entry.card.className='photoMarkerCard '+(cluster&&cid===id?'cluster':'hidden')+(isActive?' active':'')}))
}
function ensureMarkers(){if(!map)return;if(map.isStyleLoaded?.())createMarkers();else originalOn.call(map,'style.load',createMarkers)}

function syncUi(){
  if(syncQueued)return;syncQueued=true;requestAnimationFrame(()=>{syncQueued=false;const pov=inPov();nativeRemoveAttribute('disabled');nativeSetAttribute('aria-disabled',String(!pov));photoButton.classList.toggle('loading',pov&&photoLoading);photoButton.classList.toggle('active',pov&&photoVisible);if(!pov&&(photoVisible||photoLoading))hidePhoto(false);if(photoVisible)poseChip.textContent='POV · PHOTO';syncMarkers()})
}
photoButton.onclick=null;photoButton.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();photoVisible?hidePhoto(true):showPhoto()});
document.addEventListener('pointerdown',event=>{const button=event.target.closest?.('button');if(button&&button!==photoButton&&(photoVisible||photoLoading))hidePhoto(false)},true);
const observer=new MutationObserver(syncUi);observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class']});
window.addEventListener('resize',()=>{if(photoVisible&&selectedPhotoId)drawFullPhoto(selectedPhotoId)},{passive:true});
ensureMarkers();setInterval(()=>{ensureMarkers();syncUi()},180);syncUi();
