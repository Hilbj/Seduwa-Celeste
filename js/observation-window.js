const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = value => ((value % 360) + 360) % 360;

export function horizontalCoordinates(object, date, latitude, longitude) {
  if (!object || !Number.isFinite(Number(object.ra)) || !Number.isFinite(Number(object.dec)) || !(date instanceof Date) || !Number.isFinite(date.getTime()) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const gmst = wrap(280.46061837 + 360.98564736629 * (jd - 2451545) + .000387933*T*T - T*T*T/38710000);
  const Hdeg = ((gmst + longitude - Number(object.ra) * 15 + 540) % 360 - 180);
  const H = Hdeg * DEG, dec = Number(object.dec) * DEG, lat = latitude * DEG;
  const sinAlt = Math.sin(lat)*Math.sin(dec) + Math.cos(lat)*Math.cos(dec)*Math.cos(H);
  const altitude = Math.asin(clamp(sinAlt, -1, 1)) / DEG;
  const azimuth = wrap(Math.atan2(Math.sin(H), Math.cos(H)*Math.sin(lat) - Math.tan(dec)*Math.cos(lat)) / DEG + 180);
  return { altitude, azimuth };
}

export function altitudeAt(object, date, latitude, longitude) {
  return horizontalCoordinates(object, date, latitude, longitude)?.altitude ?? NaN;
}

// Approximation géométrique de la Lune (orbite moyenne + principales inégalités).
export function moonEquatorialCoordinates(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const jd = date.getTime()/86400000 + 2440587.5;
  const d = jd - 2451543.5;
  const N = wrap(125.1228 - .0529538083*d) * DEG;
  const i = 5.1454*DEG;
  const w = wrap(318.0634 + .1643573223*d) * DEG;
  const a = 60.2666;
  const e = .0549;
  const M = wrap(115.3654 + 13.0649929509*d) * DEG;
  let E = M + e*Math.sin(M)*(1+e*Math.cos(M));
  for (let k=0;k<5;k++) E -= (E-e*Math.sin(E)-M)/(1-e*Math.cos(E));
  const xv = a*(Math.cos(E)-e), yv = a*Math.sqrt(1-e*e)*Math.sin(E);
  const v = Math.atan2(yv,xv), r = Math.hypot(xv,yv);
  const xh = r*(Math.cos(N)*Math.cos(v+w)-Math.sin(N)*Math.sin(v+w)*Math.cos(i));
  const yh = r*(Math.sin(N)*Math.cos(v+w)+Math.cos(N)*Math.sin(v+w)*Math.cos(i));
  const zh = r*Math.sin(v+w)*Math.sin(i);
  const lon = Math.atan2(yh,xh), lat = Math.atan2(zh,Math.hypot(xh,yh));
  const eps = (23.4393 - 3.563e-7*d)*DEG;
  const xe = Math.cos(lon)*Math.cos(lat), ye = Math.sin(lon)*Math.cos(lat), ze = Math.sin(lat);
  const xeq = xe, yeq = ye*Math.cos(eps)-ze*Math.sin(eps), zeq = ye*Math.sin(eps)+ze*Math.cos(eps);
  const ra = wrap(Math.atan2(yeq,xeq)/DEG)/15;
  const dec = Math.atan2(zeq,Math.hypot(xeq,yeq))/DEG;
  // Phase estimate from geocentric elongation to the Sun.
  const sunLon = wrap(280.460 + .9856474*d + 1.915*Math.sin((357.528+.9856003*d)*DEG) + .020*Math.sin(2*(357.528+.9856003*d)*DEG));
  const elongation = Math.acos(clamp(Math.cos(lat)*Math.cos(lon-sunLon*DEG),-1,1))/DEG;
  const illumination = (1-Math.cos(elongation*DEG))/2;
  return { ra, dec, illumination, elongation };
}

export function angularSeparation(a, b) {
  const ra1=Number(a?.ra)*15*DEG, ra2=Number(b?.ra)*15*DEG, d1=Number(a?.dec)*DEG, d2=Number(b?.dec)*DEG;
  if (![ra1,ra2,d1,d2].every(Number.isFinite)) return NaN;
  return Math.acos(clamp(Math.sin(d1)*Math.sin(d2)+Math.cos(d1)*Math.cos(d2)*Math.cos(ra1-ra2),-1,1))/DEG;
}

export function horizonAltitudeAt(profile, azimuth) {
  if (!Array.isArray(profile) || !profile.length) return 0;
  const points = profile.filter(p=>Number.isFinite(Number(p.azimuth)) && Number.isFinite(Number(p.altitude))).map(p=>({azimuth:wrap(Number(p.azimuth)),altitude:clamp(Number(p.altitude),-5,45)})).sort((a,b)=>a.azimuth-b.azimuth);
  if (!points.length) return 0;
  if (points.length===1) return points[0].altitude;
  const az=wrap(azimuth);
  let before=points[points.length-1], after=points[0];
  for(let i=0;i<points.length;i++) if(points[i].azimuth<=az) before=points[i];
  for(let i=0;i<points.length;i++) if(points[i].azimuth>az){after=points[i];break;}
  let a=before.azimuth, b=after.azimuth, x=az; if(b<=a)b+=360; if(x<a)x+=360;
  const t=b===a?0:(x-a)/(b-a);
  return before.altitude+(after.altitude-before.altitude)*t;
}

export function calculateObservationWindow(object, date, latitude, longitude, minimumAltitude = 25, horizonProfile = []) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const samples = [];
  for (let minute=0;minute<=1440;minute+=10) {
    const at=new Date(start.getTime()+minute*60000), horizontal=horizontalCoordinates(object,at,latitude,longitude);
    const horizon=horizontal?horizonAltitudeAt(horizonProfile,horizontal.azimuth):0;
    const moon=moonEquatorialCoordinates(at);
    samples.push({minute,date:at,altitude:horizontal?.altitude??NaN,azimuth:horizontal?.azimuth??NaN,horizonAltitude:horizon,visibleAltitude:horizontal?horizontal.altitude-horizon:NaN,moonAltitude:moon?altitudeAt(moon,at,latitude,longitude):NaN,moonSeparation:moon?angularSeparation(object,moon):NaN,moonIllumination:moon?.illumination??NaN});
  }
  const valid=samples.filter(p=>Number.isFinite(p.altitude));
  if(!valid.length)return null;
  const max=valid.reduce((a,b)=>b.altitude>a.altitude?b:a);
  const windows=[]; let current=null;
  for(const p of samples){
    if(Number.isFinite(p.visibleAltitude)&&p.visibleAltitude>=minimumAltitude){if(!current)current={start:p.date,end:p.date,startMinute:p.minute,endMinute:p.minute};current.end=p.date;current.endMinute=p.minute;}
    else if(current){windows.push(current);current=null;}
  }
  if(current)windows.push(current);
  return {samples,maximum:max,windows,minimumAltitude,horizonProfile};
}

export function calculateAltitudeScale(samples, minimumAltitude = 25, includeTerrain = false) {
  const values = [];
  for (const sample of samples || []) {
    if (Number.isFinite(sample?.altitude)) values.push(sample.altitude);
    if (includeTerrain && Number.isFinite(sample?.visibleAltitude)) values.push(sample.visibleAltitude);
  }
  if (Number.isFinite(minimumAltitude)) values.push(minimumAltitude);
  // Toujours conserver l'horizon dans le graphique, tout en adaptant l'échelle
  // aux culminations basses et aux cibles circumpolaires.
  values.push(0);
  if (!values.length) return { min: -10, max: 40, step: 10 };
  const rawMin = Math.min(...values), rawMax = Math.max(...values);
  let min = Math.max(-180, Math.floor((rawMin - 5) / 5) * 5);
  let max = Math.min(180, Math.ceil((rawMax + 5) / 5) * 5);
  if (max - min < 20) { min -= 5; max += 5; }
  const span = max - min;
  const step = span <= 40 ? 5 : span <= 85 ? 10 : span <= 150 ? 20 : 30;
  return { min, max, step };
}

export async function fetchTerrainHorizon(latitude, longitude) {
  if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude < -90||latitude > 90||longitude < -180||longitude > 180) throw new Error('invalid-location');
  const distances=[2000,6000,15000], bearings=Array.from({length:32},(_,i)=>i*360/32);
  const locations=[{bearing:null,distance:0,lat:latitude,lon:longitude}];
  const rad=DEG, earth=6371000;
  for(const bearing of bearings) for(const distance of distances){
    const br=bearing*rad, delta=distance/earth, lat1=latitude*rad, lon1=longitude*rad;
    const lat2=Math.asin(Math.sin(lat1)*Math.cos(delta)+Math.cos(lat1)*Math.sin(delta)*Math.cos(br));
    const lon2=lon1+Math.atan2(Math.sin(br)*Math.sin(delta)*Math.cos(lat1),Math.cos(delta)-Math.sin(lat1)*Math.sin(lat2));
    locations.push({bearing,distance,lat:lat2/rad,lon:lon2/rad});
  }
  // Open-Meteo accepte jusqu'à 100 coordonnées, mais une URL contenant les
  // 97 points dépasse certaines limites de navigateurs/proxys. Fractionner
  // en petits lots évite les réponses HTTP 414 et les refus silencieux.
  const elevations = new Array(locations.length);
  const batchSize = 20;
  for (let start = 0; start < locations.length; start += batchSize) {
    const batch = locations.slice(start, start + batchSize);
    const params = new URLSearchParams({
      latitude: batch.map(p=>p.lat.toFixed(5)).join(','),
      longitude: batch.map(p=>p.lon.toFixed(5)).join(',')
    });
    const response = await fetch(`https://api.open-meteo.com/v1/elevation?${params.toString()}`);
    if (!response.ok) throw new Error(`terrain-http-${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.elevation) || data.elevation.length !== batch.length) {
      throw new Error(`terrain-incomplete-${start}`);
    }
    data.elevation.forEach((value, index) => { elevations[start + index] = value; });
  }
  // Modèle numérique de terrain global GLO-90 (90 m), sans bâtiments ni végétation.
  const observerElevation=elevations[0];
  if(!Number.isFinite(observerElevation))throw new Error('terrain-origin-missing');
  const groups=new Map();
  locations.slice(1).forEach((p,i)=>{const elevation=elevations[i+1];if(!Number.isFinite(elevation))return;const angle=Math.atan2(elevation-observerElevation-p.distance*p.distance/(2*earth*1.333),p.distance)/rad;groups.set(p.bearing,Math.max(groups.get(p.bearing)??-5,angle));});
  if(groups.size < 24) throw new Error('terrain-insufficient-data');
  return [...groups].map(([azimuth,altitude])=>({azimuth,altitude:Math.max(-5,altitude)}));
}

export async function fetchObservationWeather(latitude, longitude, date) {
  const day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const past = new Date(date.getFullYear(),date.getMonth(),date.getDate()) < new Date(new Date().getFullYear(),new Date().getMonth(),new Date().getDate());
  const base = past ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
  const hourly = past ? 'cloud_cover,precipitation,wind_speed_10m' : 'cloud_cover,precipitation_probability,visibility,wind_speed_10m,weather_code';
  const url=`${base}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&hourly=${hourly}&timezone=auto&start_date=${day}&end_date=${day}`;
  const response=await fetch(url); if(!response.ok)throw new Error(`weather-http-${response.status}`);
  const data=await response.json();
  if(!Array.isArray(data.hourly?.time))throw new Error('weather-incomplete');
  data.isHistorical = past;
  return data;
}
