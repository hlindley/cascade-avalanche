export const CLUSTER_ORDER = ['flatiron','noho','central'];
export const CLUSTERS = {
  flatiron: { id:'flatiron', name:'Flatiron', observations:[
    { id:'1300', time:'1:14 PM', title:'Flatiron aperitivo', coord:[-73.9893,40.7422], subject:[-73.98965,40.74111], heading:194, pitch:90, sceneZoom:17.75, povZoom:19.5, elevation:12 }
  ]},
  noho: { id:'noho', name:'NoHo / Nolita', observations:[
    { id:'1303', time:'4:32 PM', title:'Houston Street color', coord:[-73.9962,40.7221], heading:88, pitch:82, distance:14 },
    { id:'1304', time:'4:42 PM', title:'Nolita architecture', coord:[-73.9953,40.7242], heading:40, pitch:93, distance:30 },
    { id:'1308', time:'4:47 PM', title:"Old St. Patrick’s", coord:[-73.9952,40.7236], heading:330, pitch:76, distance:35 },
    { id:'1311', time:'5:07 PM', title:'Elizabeth Street Garden entrance', coord:[-73.9947,40.7222], heading:65, pitch:87, distance:15 },
    { id:'1313', time:'5:08 PM', title:'Ivy lion', coord:[-73.9945,40.7224], heading:110, pitch:80, distance:18 },
    { id:'1314', time:'5:08 PM', title:'Sculptural relief', coord:[-73.9945,40.7224], heading:145, pitch:84, distance:15 },
    { id:'1315', time:'5:10 PM', title:'Garden detail', coord:[-73.9947,40.7223], heading:220, pitch:82, distance:15 },
    { id:'1317', time:'5:12 PM', title:'Garden view', coord:[-73.9949,40.7222], heading:300, pitch:78, distance:18 },
    { id:'1320', time:'5:35 PM', title:'Bond Street birds', coord:[-73.9942,40.7265], heading:45, pitch:98, distance:30, sceneZoom:18.0, povZoom:19.65 },
    { id:'1322', time:'5:36 PM', title:'NoHo façade', coord:[-73.9940,40.7265], subject:[-73.99378,40.72668], heading:58, pitch:96, sceneZoom:18.1, povZoom:20, elevation:18 }
  ]},
  central: { id:'central', name:'Central Park', observations:[
    { id:'1323', time:'7:27 PM', title:'Central Park Boathouse', coord:[-73.9688,40.7748], heading:250, pitch:76, distance:80, sceneZoom:17.3, povZoom:18.7, elevation:10 }
  ]}
};

function rad(v){ return v*Math.PI/180; }
function destinationPoint(coord,bearing,distance){
  const R=6378137,b=rad(bearing),lat1=rad(coord[1]),lon1=rad(coord[0]),d=distance/R;
  const lat2=Math.asin(Math.sin(lat1)*Math.cos(d)+Math.cos(lat1)*Math.sin(d)*Math.cos(b));
  const lon2=lon1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(lat1),Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
  return [lon2*180/Math.PI,lat2*180/Math.PI];
}
function midpoint(a,b){ return [(a[0]+b[0])/2,(a[1]+b[1])/2]; }
for(const cluster of Object.values(CLUSTERS)){
  for(const obs of cluster.observations){
    obs.cluster=cluster.id;
    obs.subject=obs.subject||destinationPoint(obs.coord,obs.heading,obs.distance||22);
    obs.scene={center:midpoint(obs.coord,obs.subject),zoom:obs.sceneZoom||18.35,pitch:70,bearing:(obs.heading+342)%360};
    obs.pov={center:obs.subject,zoom:obs.povZoom||19.35,pitch:obs.pitch||88,bearing:obs.heading,elevation:obs.elevation||12};
    obs.photo=`./photos/${obs.id}.jpg`;
  }
}
export const ALL_OBS = CLUSTER_ORDER.flatMap(id=>CLUSTERS[id].observations);
for(const cluster of Object.values(CLUSTERS)){
  const n=cluster.observations.length;
  cluster.center=[cluster.observations.reduce((s,o)=>s+o.coord[0],0)/n,cluster.observations.reduce((s,o)=>s+o.coord[1],0)/n];
}
export const OBS_FC={type:'FeatureCollection',features:ALL_OBS.map((o,i)=>({type:'Feature',geometry:{type:'Point',coordinates:o.coord},properties:{id:o.id,cluster:o.cluster,order:i}}))};
export const PATH_FC={type:'FeatureCollection',features:CLUSTER_ORDER.flatMap(id=>{const c=CLUSTERS[id];return c.observations.length>1?[{type:'Feature',geometry:{type:'LineString',coordinates:c.observations.map(o=>o.coord)},properties:{cluster:id}}]:[]})};
export const CLUSTER_FC={type:'FeatureCollection',features:CLUSTER_ORDER.map(id=>{const c=CLUSTERS[id];return{type:'Feature',geometry:{type:'Point',coordinates:c.center},properties:{id,name:c.name,count:c.observations.length,label:`${c.name} · ${c.observations.length}`}}})};
export {rad};
