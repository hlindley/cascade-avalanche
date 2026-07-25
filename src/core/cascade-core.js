export class CascadeSimulation {
  constructor(config = {}) {
    this.size = config.size ?? 64;
    this.cellSize = config.cellSize ?? 1.25;
    this.fixedDt = config.fixedDt ?? 1 / 30;
    this.flowScale = 1;
    this.frictionScale = 1;
    this.fractureTuning = { radius: 1, decay: 1, continuity: 1, releaseDepth: 1, terrainResistance: 1 };
    this.bodyTuning = { coreDensity: 1, lateralSpread: 1, momentum: 1, entrainment: 1, powder: 1, deposition: 1 };
    this.reset(config.seed ?? 1337);
  }
  reset(seed = this.seed) {
    this.seed = seed; this.rngState = seed >>> 0; const n = this.size * this.size;
    this.height = new Float32Array(n); this.snow = new Float32Array(n); this.deposit = new Float32Array(n);
    this.stability = new Float32Array(n); this.forest = new Float32Array(n); this.fractured = new Uint8Array(n);
    this.pendingRelease = new Float32Array(n); this.moving = new Float32Array(n); this.nextMoving = new Float32Array(n);
    this.core = new Float32Array(n); this.nextCore = new Float32Array(n); this.velX = new Float32Array(n); this.velZ = new Float32Array(n);
    this.nextVelX = new Float32Array(n); this.nextVelZ = new Float32Array(n); this.powder = new Float32Array(n); this.nextPowder = new Float32Array(n);
    this.totalReleased = 0; this.elapsed = 0; this.active = false; this.settledFrames = 0; this.buildMountain();
  }
  hashNoise(x,z,salt=0){let h=(x*374761393+z*668265263+this.seed*69069+salt*362437)>>>0;h=Math.imul(h^(h>>>13),1274126177);return((h^(h>>>16))>>>0)/4294967296;}
  index(x,z){return z*this.size+x;} inBounds(x,z){return x>=0&&z>=0&&x<this.size&&z<this.size;}
  buildMountain(){
    const s=this.size,phaseA=(this.seed%997)*.013,phaseB=(this.seed%577)*.021,mainShift=(this.hashNoise(4,9,1)-.5)*.34,secondaryShift=(this.hashNoise(8,3,2)-.5)*.42,ribShift=(this.hashNoise(5,12,9)-.5)*.3,drainageLean=(this.hashNoise(19,2,10)-.5)*.42;
    for(let z=0;z<s;z++)for(let x=0;x<s;x++){
      const nx=x/(s-1)*2-1,nz=z/(s-1),upperPower=Math.pow(nz,1.25),baseSlope=36*Math.pow(nz,1.42);
      const centralBowl=-8.8*Math.exp(-Math.pow((nx-mainShift)*2.35,2))*Math.pow(nz,1.72),eastGully=-6.5*Math.exp(-Math.pow((nx-(.43+secondaryShift*.35))*5.4,2))*Math.pow(nz,1.42),westGully=-4.9*Math.exp(-Math.pow((nx+.5-secondaryShift*.25)*6.2,2))*Math.pow(nz,1.55),shoulder=4.8*Math.exp(-Math.pow((nx+.6-ribShift)*3.8,2))*Math.pow(nz,1.75);
      const curveA=mainShift+Math.sin(nz*8.1+phaseA)*.1+drainageLean*(nz-.5),curveB=-.42+secondaryShift*.3+Math.sin(nz*10.5+phaseB)*.075,curveC=.48+mainShift*.22+Math.cos(nz*9.2+phaseA*.7)*.065;
      const ravineA=-5.4*Math.exp(-Math.pow((nx-curveA)*10.5,2))*smoothstep(.18,.95,nz),ravineB=-3.8*Math.exp(-Math.pow((nx-curveB)*13.5,2))*smoothstep(.12,.82,nz),ravineC=-3.3*Math.exp(-Math.pow((nx-curveC)*14.5,2))*smoothstep(.25,.95,nz);
      const ribA=2.9*Math.exp(-Math.pow((nx-(curveA-.19))*9.5,2))*upperPower,ribB=2.5*Math.exp(-Math.pow((nx-(curveA+.22))*10.5,2))*upperPower,ribC=2*Math.exp(-Math.pow((nx-(curveB+.17))*12,2))*smoothstep(.2,.88,nz);
      const roll1=2.2*Math.exp(-Math.pow((nz-.72)*11,2))*(.45+.55*Math.cos((nx+phaseA)*5.2)),roll2=-1.8*Math.exp(-Math.pow((nz-.5)*14,2))*(.5+.5*Math.cos((nx-phaseB)*7.1)),roll3=1.35*Math.exp(-Math.pow((nz-.3)*18,2))*Math.sin((nx+phaseB)*8.5);
      const broadNoise=(Math.sin(x*.22+phaseA)+Math.cos(z*.19+phaseB)+Math.sin((x+z)*.13+phaseA*.65))*.48,fineNoise=(Math.sin(x*.66+z*.17+phaseB)+Math.cos(z*.73-x*.11+phaseA)+(this.hashNoise(x,z,3)-.5)*1.5)*.28,i=this.index(x,z);
      this.height[i]=baseSlope+centralBowl+eastGully+westGully+shoulder+ravineA+ravineB+ravineC+ribA+ribB+ribC+roll1+roll2+roll3+broadNoise+fineNoise;
      const upper=smoothstep(.25,.91,nz),leeLoading=Math.exp(-Math.pow((nx-curveA*.7)*1.55,2));this.snow[i]=clamp(.12+upper*(1.35+1.55*leeLoading)+.12*Math.sin(nx*10+nz*4+phaseA)+(this.hashNoise(x,z,4)-.5)*.18,.05,3.3);
      const bandCenter=.71+(this.hashNoise(12,7,5)-.5)*.09,band=Math.exp(-Math.pow((nz-bandCenter)*12,2)),pocketX=mainShift+(this.hashNoise(2,13,6)-.5)*.22,pocket=Math.exp(-Math.pow((nx-pocketX)*5.5,2))*Math.exp(-Math.pow((nz-.68)*7.5,2));this.stability[i]=clamp(.86-band*.42-pocket*.35-Math.max(0,roll1)*.055+(this.hashNoise(x,z,7)-.5)*.1,.08,.96);
      const treeLine=1-smoothstep(.58,.78,nz),standA=Math.exp(-Math.pow((nx+.48)*3.8,2))*Math.exp(-Math.pow((nz-.42)*5.2,2)),standB=Math.exp(-Math.pow((nx-.28)*4.5,2))*Math.exp(-Math.pow((nz-.34)*6.2,2)),ravineExclusion=clamp(1-Math.max(Math.exp(-Math.pow((nx-curveA)*13,2)),Math.exp(-Math.pow((nx-curveB)*15,2)))*.72,.15,1);this.forest[i]=clamp(treeLine*(standA*.95+standB*.8+this.hashNoise(x,z,8)*.18-.08)*ravineExclusion,0,1);
    }
  }
  configureFracture(values={}){Object.assign(this.fractureTuning,values);} configureBody(values={}){Object.assign(this.bodyTuning,values);}
  triggerAt(worldX,worldZ,power=1){
    this.fractured.fill(0);this.pendingRelease.fill(0);const gx=Math.round(worldX/this.cellSize+this.size/2),gz=Math.round(worldZ/this.cellSize+this.size/2);if(!this.inBounds(gx,gz))return{triggered:false,cells:[],boundary:[],released:0};
    const t=this.fractureTuning,impactRadius=2+Math.floor(power*1.5),maxRadius=Math.round((9+power*4)*t.radius),continuityBoost=(t.continuity-1)*.11,terrainLimit=2.6/Math.max(.55,t.terrainResistance),stabilityLimit=.16/Math.max(.55,t.terrainResistance);
    for(let dz=-impactRadius;dz<=impactRadius;dz++)for(let dx=-impactRadius;dx<=impactRadius;dx++){const x=gx+dx,z=gz+dz,d=Math.hypot(dx,dz);if(this.inBounds(x,z)&&d<=impactRadius)this.stability[this.index(x,z)]-=(1-d/(impactRadius+.01))*.78*power;}
    const queue=[[gx,gz,0]],visited=new Uint8Array(this.size*this.size),cells=[];let released=0;
    while(queue.length){const[x,z,distance]=queue.shift();if(!this.inBounds(x,z)||distance>maxRadius)continue;const i=this.index(x,z);if(visited[i])continue;visited[i]=1;const radialFade=1-distance/(maxRadius+.01),stress=this.neighborFractureRatio(x,z)*(.24+radialFade*.12)+continuityBoost,weak=this.stability[i]-stress<=.34+Math.pow(1-radialFade,1.15)*.18*t.decay;if(!weak||this.snow[i]<.35)continue;this.fractured[i]=1;const mass=this.snow[i]*clamp((.48+radialFade*.22)*t.releaseDepth,.18,.92);this.pendingRelease[i]=mass;released+=mass;cells.push({x,z,distance,radialFade});for(const[nx,nz]of neighbors8(x,z)){if(!this.inBounds(nx,nz))continue;const ni=this.index(nx,nz);if(this.stability[ni]-this.stability[i]>stabilityLimit||Math.abs(this.height[ni]-this.height[i])>terrainLimit)continue;queue.push([nx,nz,distance+Math.hypot(nx-x,nz-z)]);}}
    return{triggered:released>.05,cells,boundary:this.buildBoundary(cells),released};
  }
  commitPendingRelease(){let released=0;for(let i=0;i<this.pendingRelease.length;i++){const mass=this.pendingRelease[i];if(mass<=0)continue;this.snow[i]=Math.max(0,this.snow[i]-mass);this.moving[i]+=mass;this.core[i]+=mass*clamp(.62*this.bodyTuning.coreDensity,.35,.9);released+=mass;}this.pendingRelease.fill(0);this.totalReleased+=released;this.active=released>.05;return this.active;}
  buildBoundary(cells){const occupied=new Set(cells.map(({x,z})=>`${x},${z}`)),edges=[],defs=[[0,-1,[-.5,-.5],[.5,-.5]],[1,0,[.5,-.5],[.5,.5]],[0,1,[.5,.5],[-.5,.5]],[-1,0,[-.5,.5],[-.5,-.5]]];for(const{x,z}of cells)for(const[dx,dz,a,b]of defs)if(!occupied.has(`${x+dx},${z+dz}`))edges.push({x,z,a,b});return edges;}
  neighborFractureRatio(x,z){let count=0,fractured=0;for(const[nx,nz]of neighbors8(x,z))if(this.inBounds(nx,nz)){count++;fractured+=this.fractured[this.index(nx,nz)]?1:0;}return count?fractured/count:0;}
  step(dt=this.fixedDt){
    if(!this.active)return;this.elapsed+=dt;this.nextMoving.fill(0);this.nextCore.fill(0);this.nextVelX.fill(0);this.nextVelZ.fill(0);this.nextPowder.fill(0);const t=this.bodyTuning;let activeMass=0;
    for(let z=1;z<this.size-1;z++)for(let x=1;x<this.size-1;x++){const i=this.index(x,z),mass=this.moving[i];if(mass<.003)continue;const forest=this.forest[i],coreRatio=clamp(this.core[i]/Math.max(mass,.001),0,1),previousX=this.velX[i],previousZ=this.velZ[i],candidates=[];let totalWeight=0,steepest=0;const current=this.height[i]+this.snow[i]+this.deposit[i]+mass*.08;
      for(const[nx,nz]of neighbors8(x,z)){const ni=this.index(nx,nz),dx=nx-x,dz=nz-z,drop=current-(this.height[ni]+this.snow[ni]+this.deposit[ni]+this.moving[ni]*.04);if(drop<=.01)continue;steepest=Math.max(steepest,drop);const len=Math.hypot(dx,dz),dirX=dx/len,dirZ=dz/len,alignment=Math.max(-.2,dirX*previousX+dirZ*previousZ),weight=Math.pow(drop,1.35)*(1+coreRatio*drop*.34*t.coreDensity)*(1+(1-coreRatio)*.42*t.lateralSpread)*(1+Math.max(0,alignment)*2.2*t.momentum);candidates.push({ni,dx:dirX,dz:dirZ,drop,weight});totalWeight+=weight;}
      const slopeEnergy=clamp(steepest/4.8,0,1),speed=clamp(Math.hypot(previousX,previousZ)*.72*t.momentum+slopeEnergy*.48*this.flowScale-(.065*this.frictionScale+forest*.3),0,2.9*this.flowScale),moveFraction=candidates.length?clamp((.14+speed*.24)*(1-forest*.68),.02,.84):0,outgoing=mass*moveFraction;let retained=mass-outgoing;const settle=retained*clamp((.035+(1-slopeEnergy)*.12+forest*.09)*t.deposition,.01,.38);retained-=settle;this.deposit[i]+=settle;this.nextMoving[i]+=retained;this.nextCore[i]+=Math.min(retained,this.core[i]*(retained/Math.max(mass,.001)));
      if(candidates.length&&totalWeight>0)for(const c of candidates){const share=c.weight/totalWeight,destinationForest=this.forest[c.ni],amount=outgoing*share*(1-destinationForest*.24),entrain=Math.min(this.snow[c.ni]*.1*speed*t.entrainment*(1-destinationForest*.7),amount*.55);this.snow[c.ni]-=entrain;this.totalReleased+=entrain;const moved=amount+entrain;this.nextMoving[c.ni]+=moved;this.nextCore[c.ni]+=moved*clamp(coreRatio+c.drop*.035*t.coreDensity-(1-share)*.12,.18,.92);const vx=previousX*.58*t.momentum+c.dx*speed,vz=previousZ*.58*t.momentum+c.dz*speed;if(Math.hypot(vx,vz)>Math.hypot(this.nextVelX[c.ni],this.nextVelZ[c.ni])){this.nextVelX[c.ni]=vx;this.nextVelZ[c.ni]=vz;}this.nextPowder[c.ni]+=moved*speed*(.05+(1-share)*.07)*t.powder;}
      this.nextPowder[i]+=this.powder[i]*.91;activeMass+=this.nextMoving[i];
    }
    [this.moving,this.nextMoving]=[this.nextMoving,this.moving];[this.core,this.nextCore]=[this.nextCore,this.core];[this.velX,this.nextVelX]=[this.nextVelX,this.velX];[this.velZ,this.nextVelZ]=[this.nextVelZ,this.velZ];[this.powder,this.nextPowder]=[this.nextPowder,this.powder];this.settledFrames=activeMass<.18?this.settledFrames+1:0;if(this.settledFrames>32||this.elapsed>30)this.active=false;
  }
  getFlowCenter(){let sum=0,xSum=0,zSum=0,speedSum=0;for(let z=0;z<this.size;z++)for(let x=0;x<this.size;x++){const i=this.index(x,z),weight=this.moving[i]*(.35+this.core[i]);if(weight<=.01)continue;sum+=weight;xSum+=x*weight;zSum+=z*weight;speedSum+=Math.hypot(this.velX[i],this.velZ[i])*weight;}if(!sum)return null;return{x:(xSum/sum-this.size/2)*this.cellSize,z:(zSum/sum-this.size/2)*this.cellSize,speed:speedSum/sum,mass:sum};}
  worldPosition(x,z){const i=this.index(x,z);return{x:(x-this.size/2)*this.cellSize,y:this.height[i]+this.snow[i]+this.deposit[i],z:(z-this.size/2)*this.cellSize};}
  sampleWorldHeight(wx,wz){const x=clamp(Math.round(wx/this.cellSize+this.size/2),0,this.size-1),z=clamp(Math.round(wz/this.cellSize+this.size/2),0,this.size-1),i=this.index(x,z);return this.height[i]+this.snow[i]+this.deposit[i];}
}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));const smoothstep=(a,b,v)=>{const t=clamp((v-a)/(b-a),0,1);return t*t*(3-2*t);};const neighbors8=(x,z)=>[[x-1,z-1],[x,z-1],[x+1,z-1],[x-1,z],[x+1,z],[x-1,z+1],[x,z+1],[x+1,z+1]];