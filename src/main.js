import { CascadeScene } from './game/scene.js';

const $ = (id) => document.getElementById(id);
const ui = {
  setShot(value){ $('shotState').textContent=value; },
  update(mass,damage){ $('releasedMass').textContent=`${Math.round(mass).toLocaleString()} t`; $('damageScore').textContent=damage.toLocaleString(); },
  disableFire(value){ $('fireButton').disabled=value; },
  showResult(title){ $('resultTitle').textContent=title; $('resultPanel').hidden=false; },
  showReticle(scene,camera,point){
    const projected=BABYLON.Vector3.Project(point,BABYLON.Matrix.Identity(),scene.getTransformMatrix(),camera.viewport.toGlobal(scene.getEngine().getRenderWidth(),scene.getEngine().getRenderHeight()));
    const r=$('reticle');r.style.display='block';r.style.left=`${projected.x}px`;r.style.top=`${projected.y}px`;
  }
};
const game = new CascadeScene($('renderCanvas'), ui);
$('fireButton').addEventListener('click',()=>game.fire());
$('resetButton').addEventListener('click',()=>game.reset());
$('retryButton').addEventListener('click',()=>game.reset());
