import { CascadeScene } from './game/scene.js';
const $ = (id) => document.getElementById(id);
const ui = {
  setShot(value){ $('shotState').textContent=value; },
  update(mass,damage){ $('releasedMass').textContent=`${Math.round(mass).toLocaleString()} t`; $('damageScore').textContent=damage.toLocaleString(); },
  disableFire(value){ $('fireButton').disabled=value; },
  showResult(title){ $('resultTitle').textContent=title; $('resultPanel').hidden=false; },
  showReticle(scene,camera,point){ const p=BABYLON.Vector3.Project(point,BABYLON.Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(scene.getEngine().getRenderWidth(),scene.getEngine().getRenderHeight())); const r=$('reticle');r.style.display='block';r.style.left=`${p.x}px`;r.style.top=`${p.y}px`; },
  setSeed(seed){ $('seedValue').textContent=seed; },
  setFps(fps){ $('fpsValue').textContent=Math.round(fps); }
};
const game = new CascadeScene($('renderCanvas'), ui);
$('fireButton').addEventListener('click',()=>game.fire());
$('resetButton').addEventListener('click',()=>game.reset());
$('retryButton').addEventListener('click',()=>game.reset());
$('reseedButton').addEventListener('click',()=>game.reseed());
const panel=$('tuningPanel'),toggle=$('tuneToggle');
const setPanel=(open)=>{panel.hidden=!open;toggle.setAttribute('aria-expanded',String(open));};
toggle.addEventListener('click',()=>setPanel(panel.hidden)); $('closeTune').addEventListener('click',()=>setPanel(false));
for(const [id,key] of [['cohesion','cohesion'],['speed','speed'],['friction','friction'],['light','light']]){ const input=$(id),out=$(`${id}Out`); input.addEventListener('input',()=>{out.value=Number(input.value).toFixed(2);game.setTuning(key,Number(input.value));}); }
