// The report's CSS tokens (light and dark) and the tooltip script, as in the first report.

export const CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#6f6d68;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--good:#0ca30c;--warn:#fab219;--crit:#d03b3b;--code:#f0efec;--link:#1c5cab}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9b9992;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--good:#3cc13c;--warn:#e0a019;--crit:#e5615f;--code:#262624;--link:#86b6ef}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--muted:#9b9992;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--good:#3cc13c;--warn:#e0a019;--crit:#e5615f;--code:#262624;--link:#86b6ef}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--page);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:40px 20px 80px}
header.top{margin-bottom:28px}
h1{font-size:30px;line-height:1.2;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--ink2);margin:0}
nav{display:flex;flex-wrap:wrap;gap:6px 16px;margin:18px 0 0;font-size:14px}
a{color:var(--link)}
nav a{text-decoration:none}
nav a:hover{text-decoration:underline}
section{margin-top:44px}
h2{font-size:22px;margin:0 0 12px;padding-top:8px;border-top:1px solid var(--border)}
h3{font-size:17px;margin:28px 0 10px}
p{margin:0 0 12px;max-width:78ch}
ul{margin:0 0 12px;padding-left:20px;max-width:80ch}
li{margin-bottom:6px}
code{font:13px/1.4 ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px;overflow-wrap:anywhere}
.banner{border:1px solid var(--border);border-left:4px solid var(--warn);background:var(--surface);border-radius:8px;padding:12px 16px;margin:16px 0}
.banner.crit{border-left-color:var(--crit)}
.meta{display:grid;grid-template-columns:140px 1fr;gap:4px 14px;margin:16px 0 0;font-size:14.5px}
.meta dt{color:var(--ink2);font-weight:600}
.meta dd{margin:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:16px 0 20px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.tlabel{font-size:13px;color:var(--ink2)}
.tvalue{font-size:22px;font-weight:600;line-height:1.3;margin-top:2px}
.tvalue .ref,.tvalue .d{font-size:13px;font-weight:400}
figure{margin:16px 0;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;min-width:0}
figcaption{font-size:13px;color:var(--muted);margin-top:8px}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,440px),1fr));gap:12px}
.two figure{margin:8px 0}
.chart{display:block;width:100%;height:auto;overflow:visible}
.scroll{overflow-x:auto}
.wide{min-width:620px}
.chart text{font:12.5px system-ui,-apple-system,"Segoe UI",sans-serif;fill:var(--ink)}
.chart .lab{fill:var(--ink2)}
.chart .val{font-weight:600;font-variant-numeric:tabular-nums}
.chart .tick{fill:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{stroke:var(--axis);stroke-width:1}
.chart .cross{stroke:var(--axis);stroke-width:1}
.chart .mark{outline:none}
.chart .mark:hover,.chart .mark:focus-visible{filter:brightness(1.12)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--ink2);margin-bottom:10px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
.tablewrap{overflow-x:auto;margin:10px 0 14px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid);vertical-align:top}
th{font-weight:600;color:var(--ink2);font-size:13px;white-space:nowrap}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ref{display:block;color:var(--muted);font-size:12px}
.d{display:block;font-size:12px;font-weight:600}
.d.up{color:var(--crit)}
.d.down{color:var(--good)}
.d.same{color:var(--muted);font-weight:400}
.tag{font-size:11.5px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:0 7px;margin-left:6px;white-space:nowrap}
.muted{color:var(--muted)}
details{margin:10px 0 14px}
summary{cursor:pointer;color:var(--link);font-size:14px}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--page);font-size:12.5px;padding:5px 8px;border-radius:6px;max-width:340px;z-index:10;opacity:0;transition:opacity .08s}
@media (max-width:640px){.meta{grid-template-columns:1fr}h1{font-size:25px}main{padding:24px 16px 60px}}
@media print{nav,#tip{display:none}details{display:block}details>summary{display:none}}
`;

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
`;
