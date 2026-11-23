// The report's CSS and its script. The colors are the app's tokens (packages/webui-theme/theme.css), copied: the report
// is one file with no external resource. Its page is flat, without the app's aurora: figures read better on it.

const LIGHT =
  'color-scheme:light;--page:oklch(0.962 0.007 252);--surface:oklch(1 0 0 / 64%);--highlight:oklch(1 0 0 / 92%);--ink:oklch(0.19 0.015 255);--ink2:oklch(0.36 0.016 255);--muted:oklch(0.46 0.016 255);--line:oklch(0.2 0.015 255 / 10%);--grid:oklch(0.2 0.015 255 / 7%);--axis:oklch(0.2 0.015 255 / 24%);--well:oklch(0.22 0.015 255 / 5.5%);--hover:oklch(0.22 0.015 255 / 3.5%);--link:oklch(0.45 0.2 258);--ring:oklch(0.55 0.2 258 / 55%);--s1:oklch(0.55 0.2 258);--s2:oklch(0.58 0.11 190);--s3:oklch(0.65 0.15 65);--s4:oklch(0.56 0.19 278);--good:oklch(0.44 0.13 155);--warn:oklch(0.65 0.15 65);--crit:oklch(0.5 0.21 25);--tip:oklch(0.19 0.015 255);--tip-ink:oklch(0.985 0.006 250)';
const DARK =
  'color-scheme:dark;--page:oklch(0.098 0.01 260);--surface:oklch(0.195 0.012 258 / 56%);--highlight:oklch(1 0 0 / 11%);--ink:oklch(0.965 0.005 255);--ink2:oklch(0.84 0.012 255);--muted:oklch(0.73 0.015 255);--line:oklch(1 0 0 / 10%);--grid:oklch(1 0 0 / 7%);--axis:oklch(1 0 0 / 22%);--well:oklch(1 0 0 / 7%);--hover:oklch(1 0 0 / 4%);--link:oklch(0.74 0.16 256);--ring:oklch(0.68 0.19 255 / 60%);--s1:oklch(0.58 0.2 258);--s2:oklch(0.665 0.12 180);--s3:oklch(0.665 0.15 72);--s4:oklch(0.65 0.19 278);--good:oklch(0.78 0.15 155);--warn:oklch(0.82 0.15 75);--crit:oklch(0.7 0.19 22);--tip:oklch(0.26 0.012 258);--tip-ink:oklch(0.965 0.005 255)';

/** The app's faces when the machine has them, the system's otherwise: nothing is downloaded. */
const SANS = "'Inter Variable',Inter,system-ui,-apple-system,'Segoe UI',sans-serif";
const MONO = "'JetBrains Mono Variable','JetBrains Mono',ui-monospace,'SF Mono',Menlo,Consolas,monospace";

/** A table with one numeric column: narrow, and from 720 px the whole comparison of a cell fits on its row. */
const ONE = 'table:not(:has(th:nth-child(3)))';
/** A table of six columns or more: the reference and the difference each on their line, to keep it narrow. */
const MANY = 'table:has(th:nth-child(6))';

/** Where the theme chosen with the switch is kept; without it the report follows the system. */
const THEME_KEY = 'llama-webui-profiling:theme';

export const CSS = `
:root{${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${DARK}}}
:root[data-theme="dark"]{${DARK}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%;background:var(--page)}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;color:var(--ink);font:15px/1.55 ${SANS};font-variant-numeric:tabular-nums}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:4px}
a{color:var(--link)}
.shell{max-width:1320px;margin:0 auto;padding:0 20px}
.side{padding:20px 0 0}
.sidetop{display:flex;align-items:center;justify-content:space-between;gap:12px}
.brand{font-weight:650;letter-spacing:-.01em}
.brand span{display:block;font-weight:400;font-size:13px;color:var(--muted);letter-spacing:0}
nav{display:flex;flex-wrap:wrap;gap:2px 4px;margin:14px -8px 0;font-size:14px}
nav a{color:var(--ink2);text-decoration:none;padding:4px 8px;border-radius:8px}
nav a:hover{background:var(--hover);color:var(--ink)}
nav a[aria-current="true"]{background:var(--well);color:var(--ink);font-weight:600}
.theme{display:inline-flex;padding:2px;border-radius:999px;background:var(--well)}
.theme button{font:inherit;font-size:12.5px;color:var(--muted);background:none;border:0;padding:3px 10px;border-radius:999px;cursor:pointer}
.theme button:hover{color:var(--ink)}
.theme button[aria-pressed="true"]{background:var(--surface);color:var(--ink);box-shadow:0 0 0 1px var(--line)}
main{min-width:0;padding:28px 0 80px}
@media (min-width:1100px){
.shell{display:grid;grid-template-columns:200px minmax(0,1040px);gap:36px;justify-content:center}
.side{position:sticky;top:0;align-self:start;height:100vh;padding:36px 0 24px;display:flex;flex-direction:column;overflow-y:auto}
.sidetop{display:contents}
.brand{padding-left:10px}
nav{flex-direction:column;flex-wrap:nowrap;gap:1px;margin:22px 0}
nav a{padding:5px 10px}
.theme{order:3;align-self:start;margin:auto 0 0 8px}
main{padding-top:36px}
}
header.top{margin-bottom:8px}
h1{font-size:34px;line-height:1.15;font-weight:680;letter-spacing:-.022em;margin:0 0 6px;overflow-wrap:anywhere}
.sub{color:var(--ink2);margin:0}
.meta{display:grid;grid-template-columns:104px minmax(0,1fr);gap:0;margin:22px 0 0;font-size:14px;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:inset 0 1px 0 var(--highlight);padding:6px 18px}
.meta dt,.meta dd{margin:0;padding:8px 0;border-top:1px solid var(--grid)}
.meta dt:first-of-type,.meta dt:first-of-type+dd{border-top:0}
.meta dt{color:var(--muted)}
.meta dd code{display:inline-block;border-radius:999px;padding:1px 9px;margin:1px 2px 1px 0}
section{margin-top:56px;scroll-margin-top:20px}
h2{font-size:23px;line-height:1.25;font-weight:660;letter-spacing:-.014em;margin:0 0 10px;padding-top:26px;border-top:1px solid var(--line)}
h3{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;font-size:17px;font-weight:640;letter-spacing:-.008em;margin:36px 0 12px}
h4{font-size:14.5px;font-weight:640;margin:24px 0 8px}
p{margin:0 0 12px;max-width:74ch}
ul{margin:0 0 12px;padding-left:20px;max-width:76ch}
li{margin-bottom:6px}
.muted{color:var(--muted)}
code{font:12.5px/1.4 ${MONO};background:var(--well);padding:1px 5px;border-radius:5px;overflow-wrap:anywhere}
.tag{font-size:12px;font-weight:500;letter-spacing:0;color:var(--ink2);background:var(--well);border-radius:999px;padding:1px 9px;white-space:nowrap}
td .tag{margin-left:8px}
.banner{border:1px solid color-mix(in oklch,var(--warn) 40%,transparent);background:color-mix(in oklch,var(--warn) 9%,var(--surface));border-radius:14px;padding:12px 16px;margin:16px 0}
.banner.crit{border-color:color-mix(in oklch,var(--crit) 45%,transparent);background:color-mix(in oklch,var(--crit) 9%,var(--surface))}
.ref{color:var(--muted);font-size:12.5px;font-weight:400}
.d{font-size:12.5px;font-weight:600;white-space:nowrap}
.d.same{color:var(--muted);font-weight:400}
.d.up{color:var(--crit)}
.d.down{color:var(--good)}
p .ref::before{content:" ("}
p .ref::after{content:", "}
p .d::after{content:")"}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:10px;margin:14px 0 18px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:inset 0 1px 0 var(--highlight);padding:12px 14px 13px}
.tlabel{font-size:13px;color:var(--muted)}
.tvalue{font-size:23px;font-weight:640;letter-spacing:-.015em;line-height:1.3;margin-top:1px}
.tvalue .v{display:block}
.tvalue .ref,.tvalue .d{letter-spacing:0;vertical-align:middle}
.tvalue .ref{margin-right:6px}
.tvalue .d{display:inline-block;padding:0 8px;line-height:1.6;border-radius:999px;background:var(--well)}
.tvalue .d.same{background:none;padding:0}
figure{margin:16px 0;background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:inset 0 1px 0 var(--highlight);padding:16px 18px 14px;min-width:0}
figcaption{font-size:13px;color:var(--muted);margin-top:10px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:12px}
.two figure{margin:8px 0}
.chart{display:block;width:100%;height:auto;overflow:visible}
.scroll{overflow-x:auto}
.wide{min-width:620px}
.chart text{font:12.5px ${SANS};fill:var(--ink)}
.chart .lab{fill:var(--ink2)}
.chart .val{font-weight:600;font-variant-numeric:tabular-nums}
.chart .tick{fill:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis,.chart .cross{stroke:var(--axis);stroke-width:1}
.chart .mark{outline:none}
.chart .mark:hover,.chart .mark:focus-visible{filter:brightness(1.14) saturate(1.1)}
.chart g.mark:focus-visible>rect:first-child{fill:var(--hover)}
.chart rect.mark:focus-visible{stroke:var(--ink);stroke-width:1.5}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--ink2);margin-bottom:12px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:7px}
.tablewrap{overflow-x:auto;margin:10px 0 16px}
table{border-collapse:separate;border-spacing:0;width:100%;font-size:14px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--grid);vertical-align:baseline}
th{font-weight:500;color:var(--muted);font-size:12.5px;white-space:nowrap;border-bottom-color:var(--line)}
th:first-child,td:first-child{padding-left:0}
th:last-child,td:last-child{padding-right:0}
tbody tr:hover>td{background:var(--hover)}
.num{text-align:right;white-space:nowrap}
td .v{display:block;font-weight:550}
td .ref{display:inline-block}
td .d{display:inline-block;margin-left:8px}
td .d.changed{padding:0 7px;border-radius:999px;background:var(--well)}
td:not(:last-child) .d.changed{margin-right:-7px}
#changed td .d.changed{padding:0;margin-right:0;background:none;font-size:14px}
${MANY} th{white-space:normal;vertical-align:bottom}
${MANY} td .ref{display:block}
${MANY} td .d{margin-left:0}
${ONE}{width:min(100%,660px)}
.tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:14px 0 6px;font-size:14px}
.tools input[type="search"]{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:6px 12px;width:min(100%,300px)}
.tools input::placeholder{color:var(--muted)}
.tools label{display:inline-flex;align-items:center;gap:6px;color:var(--ink2)}
.tools .count{font-size:13px;color:var(--muted)}
tr.group>th{position:static;background:none;color:var(--ink);font-size:14px;font-weight:640;padding-top:20px;white-space:normal}
tr.group .tag{margin-left:8px}
table.grouped .win{display:none}
@media (min-width:720px){
#changed .tablewrap{overflow-x:visible}
#changed thead th{position:sticky;top:0;z-index:1;background:var(--page)}
${ONE} td .v{display:inline-block;min-width:8ch}
${ONE} td .ref{min-width:13ch}
${ONE} td .d{min-width:11ch;margin-left:0}
${ONE} td .d.changed{padding:0;background:none}
}
details{margin:8px 0 12px}
summary{cursor:pointer;color:var(--ink2);font-size:14px;font-weight:500;list-style:none;display:inline-flex;align-items:center;gap:8px;padding:4px 10px 4px 8px;margin-left:-8px;border-radius:8px}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .12s}
details[open]>summary::before{transform:rotate(45deg) translate(-1px,-1px)}
summary:hover{background:var(--hover);color:var(--ink)}
#tip{position:fixed;pointer-events:none;background:var(--tip);color:var(--tip-ink);font-size:12.5px;padding:5px 9px;border-radius:8px;max-width:340px;z-index:10;opacity:0;transition:opacity .08s}
@media (max-width:719px){td:first-child{overflow-wrap:anywhere}th,td{padding-left:5px;padding-right:5px}table{font-size:13.5px}}
@media (max-width:640px){h1{font-size:27px}.meta{grid-template-columns:1fr;padding:8px 14px}.meta dd{border-top:0;padding-top:0}.meta dt{padding-bottom:0}.shell{padding:0 16px}.tiles{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
@media print{.side,#tip,.tools{display:none}.shell{display:block;max-width:none}details{display:block}details>summary{display:none}#changed thead th{position:static}figure,.tile,tr{break-inside:avoid}}
`;

/** In `<head>`, before the first paint: the stored theme, so a reload does not flash the other one. */
export const THEME_SCRIPT = `try{const t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch{}`;

export const SCRIPT = `
const tip=document.getElementById('tip');
const show=(text,x,y)=>{tip.textContent=text;tip.style.opacity=1;const w=tip.offsetWidth;tip.style.left=Math.max(8,Math.min(innerWidth-w-8,x+12))+'px';tip.style.top=Math.max(8,y-34)+'px'};
const hide=()=>{tip.style.opacity=0};
for(const el of document.querySelectorAll('[data-tip]')){
  el.addEventListener('mousemove',e=>show(el.dataset.tip,e.clientX,e.clientY));
  el.addEventListener('mouseleave',hide);
  el.addEventListener('focus',()=>{const r=el.getBoundingClientRect();show(el.dataset.tip,r.left+r.width/2,r.top)});
  el.addEventListener('blur',hide);
}
for(const svg of document.querySelectorAll('.linechart')){
  const pts=JSON.parse(svg.dataset.points),cross=svg.querySelector('.cross'),dot=svg.querySelector('.crossdot'),hit=svg.querySelector('.hit');
  hit.addEventListener('mousemove',e=>{
    const r=svg.getBoundingClientRect(),vb=svg.viewBox.baseVal,x=(e.clientX-r.left)/r.width*vb.width;
    let best=pts[0];for(const p of pts)if(Math.abs(p[0]-x)<Math.abs(best[0]-x))best=p;
    cross.setAttribute('x1',best[0]);cross.setAttribute('x2',best[0]);cross.setAttribute('visibility','visible');
    dot.setAttribute('cx',best[0]);dot.setAttribute('cy',best[1]);dot.setAttribute('visibility','visible');
    show(best[2],e.clientX,e.clientY);
  });
  hit.addEventListener('mouseleave',()=>{cross.setAttribute('visibility','hidden');dot.setAttribute('visibility','hidden');hide()});
}
const themes=[...document.querySelectorAll('.theme button')];
const paintTheme=()=>{const cur=document.documentElement.dataset.theme??'auto';for(const b of themes)b.setAttribute('aria-pressed',String(b.dataset.theme===cur))};
for(const b of themes)b.addEventListener('click',()=>{
  const t=b.dataset.theme;
  if(t==='auto')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=t;
  try{if(t==='auto')localStorage.removeItem('${THEME_KEY}');else localStorage.setItem('${THEME_KEY}',t)}catch{}
  paintTheme();
});
paintTheme();
const links=new Map([...document.querySelectorAll('nav a')].map(a=>[a.getAttribute('href').slice(1),a]));
const spy=new IntersectionObserver(entries=>{
  for(const e of entries){if(!e.isIntersecting)continue;for(const a of links.values())a.removeAttribute('aria-current');links.get(e.target.id)?.setAttribute('aria-current','true')}
},{rootMargin:'-12% 0px -80% 0px'});
for(const id of links.keys()){const s=document.getElementById(id);if(s)spy.observe(s)}
const filter=document.getElementById('changed-filter');
if(filter){
  const table=document.querySelector('#changed table'),body=table.tBodies[0],rows=[...body.rows];
  const count=document.getElementById('changed-count'),by=document.getElementById('changed-group');
  const groups=new Map();
  for(const r of rows){const k=r.dataset.group;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r)}
  const heads=[...groups].map(([k,list])=>{
    const head=document.createElement('tr'),th=document.createElement('th'),n=document.createElement('span');
    head.className='group';th.colSpan=4;th.scope='rowgroup';th.textContent=k;n.className='tag';th.append(n);head.append(th);
    return{head,n,list};
  });
  const apply=()=>{
    const q=filter.value.trim().toLowerCase();let shown=0;
    for(const r of rows){r.hidden=q!==''&&!r.cells[0].textContent.toLowerCase().includes(q);if(!r.hidden)shown++}
    for(const g of heads){const k=g.list.filter(r=>!r.hidden).length;g.head.hidden=k===0;g.n.textContent=String(k)}
    table.classList.toggle('grouped',by.checked);
    body.replaceChildren(...(by.checked?heads.flatMap(g=>[g.head,...g.list]):rows));
    const all=rows.length===1?'1 figure':rows.length+' figures';
    count.textContent=shown===rows.length?all:shown+' of '+all;
  };
  filter.addEventListener('input',apply);by.addEventListener('change',apply);apply();
}
`;
