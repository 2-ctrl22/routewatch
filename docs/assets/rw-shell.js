/* RouteWatch shell: one header, one navigation, on every page.
 * Desktop: a top bar with every section. Phone: a slim top bar plus an app-style
 * tab bar at the bottom, with the less used sections in a "More" sheet.
 * Include right after <body>; the page calls RW.setActive() and RW.setMeta(). */
(function(){
  const I={
    overview:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7.5" height="9" rx="2"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="2"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="2"/><rect x="3" y="15" width="7.5" height="6" rx="2"/></svg>',
    routes:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="6" r="2.2"/><path d="M6.8 16.6C9 11 12.5 8.4 16.9 7.1"/><path d="M4 8h5M4 5h8" opacity=".55"/></svg>',
    find:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M20 20l-4.8-4.8"/></svg>',
    map:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z"/></svg>',
    more:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg>',
    buy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12.2V4.5A1.5 1.5 0 0 1 4.5 3h7.7l8.8 8.8a1.5 1.5 0 0 1 0 2.1l-7.1 7.1a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.6"/></svg>',
    changes:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>',
    seasons:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/></svg>',
    fleet:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M21 15.5v-1.8l-8-5V3.8a1.5 1.5 0 0 0-3 0v4.9l-8 5v1.8l8-2.5v5.2l-2 1.5v1.5l3.5-1 3.5 1v-1.5l-2-1.5V13z"/></svg>',
    editor:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>'
  };
  const LOGO='<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="rwg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d3350"/><stop offset="1" stop-color="#0f1b2a"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#rwg)"/><rect x=".5" y=".5" width="31" height="31" rx="7.5" fill="none" stroke="#5cabff" stroke-opacity=".35"/><path d="M8 22.5C11.5 13 17.5 9.5 24 9" fill="none" stroke="#5cabff" stroke-width="2" stroke-linecap="round" stroke-dasharray="0.1 3.6"/><circle cx="8" cy="22.5" r="3" fill="#3fcf6b"/><circle cx="24" cy="9" r="3" fill="#5cabff"/></svg>';

  const NAV=[
    {id:'overview',href:'index.html#overview',label:'Overview'},
    {id:'routes',href:'index.html#routes',label:'Routes'},
    {id:'buy',href:'index.html#buy',label:'Buy advice',desc:'Which airport opens up the most flying'},
    {id:'changes',href:'index.html#changes',label:'Changes',desc:'Every route and aircraft change'},
    {id:'seasons',href:'index.html#seasons',label:'Seasons',desc:'Summer and winter timetables'},
    {id:'fleet',href:'index.html#fleet',label:'Fleet',desc:'Your aircraft and substitutes'},
    {sep:true},
    {id:'map',href:'map.html',label:'Map'},
    {id:'find',href:'find.html',label:'Find a flight',short:'Find'},
    {id:'editor',href:'editor.html',label:'Editor',desc:'Edit airports and fleet'}
  ];
  const TABS=['overview','routes','find','map'];
  const MORE=['buy','changes','seasons','fleet','editor'];
  const byId=Object.fromEntries(NAV.filter(n=>n.id).map(n=>[n.id,n]));

  const top=NAV.map(n=>n.sep?'<span class="sep"></span>'
    :'<a href="'+n.href+'" data-nav="'+n.id+'">'+n.label+'</a>').join('');
  const hdr='<header class="rw-hdr"><a class="rw-brand" href="index.html#overview">'+LOGO
    +'<span>RouteWatch</span></a><nav class="rw-top" aria-label="Sections">'+top+'</nav>'
    +'<div class="rw-meta" id="rw-meta"><span class="dot"></span><span>loading</span></div></header>';
  const tabs='<nav class="rw-tabs" aria-label="Sections">'
    +TABS.map(id=>{const n=byId[id];return '<a href="'+n.href+'" data-nav="'+id+'">'+I[id]
      +'<span>'+(n.short||n.label)+'</span></a>';}).join('')
    +'<button type="button" id="rw-more-btn" data-nav="more" aria-haspopup="dialog">'+I.more+'<span>More</span></button></nav>'
    +'<div class="rw-sheet-bg" id="rw-sheet-bg"></div>'
    +'<div class="rw-sheet" id="rw-sheet" role="dialog" aria-label="More sections"><div class="rw-grab"></div>'
    +'<h3>More</h3><div class="rw-more">'
    +MORE.map(id=>{const n=byId[id];return '<a href="'+n.href+'" data-nav="'+id+'">'+I[id]+n.label
      +'<small>'+n.desc+'</small></a>';}).join('')
    +'</div></div>';

  document.body.insertAdjacentHTML('afterbegin',hdr);
  document.body.insertAdjacentHTML('beforeend',tabs);

  const sheet=document.getElementById('rw-sheet'), bg=document.getElementById('rw-sheet-bg');
  const openSheet=v=>{sheet.classList.toggle('open',v);bg.classList.toggle('open',v);};
  document.getElementById('rw-more-btn').addEventListener('click',()=>openSheet(!sheet.classList.contains('open')));
  bg.addEventListener('click',()=>openSheet(false));
  sheet.addEventListener('click',e=>{if(e.target.closest('a'))openSheet(false);});
  let y0=null;
  sheet.addEventListener('touchstart',e=>{y0=e.touches[0].clientY;},{passive:true});
  sheet.addEventListener('touchmove',e=>{if(y0!==null&&e.touches[0].clientY-y0>60&&sheet.scrollTop<=0){openSheet(false);y0=null;}},{passive:true});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')openSheet(false);});

  function setActive(id){
    document.querySelectorAll('[data-nav]').forEach(a=>a.classList.toggle('on',a.dataset.nav===id));
    const mb=document.getElementById('rw-more-btn');
    if(mb) mb.classList.toggle('on',MORE.includes(id));
  }
  /* The dot turns amber when the data is more than a day and a half old, red after three days. */
  function setMeta(html,iso){
    const h=iso?(Date.now()-new Date(iso))/36e5:0;
    const c=h>72?'var(--bad)':h>36?'var(--warn)':'';
    document.getElementById('rw-meta').innerHTML='<span class="dot"'+(c?' style="background:'+c+';box-shadow:0 0 0 3px transparent"':'')+'></span>'+html;
  }

  /* "28 Sep, 11:35" in the viewer's own time zone. */
  function when(iso){
    const d=new Date(iso); if(isNaN(d)) return String(iso||'').slice(0,16);
    const mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const p=n=>String(n).padStart(2,'0');
    return d.getDate()+' '+mon+', '+p(d.getHours())+':'+p(d.getMinutes());
  }
  function ago(iso){
    const d=new Date(iso); if(isNaN(d)) return '';
    const h=(Date.now()-d)/36e5;
    if(h<1) return 'just now';
    if(h<24) return Math.round(h)+' h ago';
    const days=Math.round(h/24); return days+(days===1?' day ago':' days ago');
  }
  window.RW={setActive,setMeta,when,ago,icons:I,page:document.body.dataset.page||''};
  if(document.body.dataset.page) setActive(document.body.dataset.page);
})();
