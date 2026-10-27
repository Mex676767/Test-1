const app=document.getElementById('app');
const KB={categories:[],guides:[]};
const TONES=['cyan','violet','rose','orange','green'];
const KNOWN_TONES={Deposit:'cyan',Withdrawal:'violet','Special Bonus':'rose',SOP:'orange'};
const CATEGORY_ORDER=['Deposit','Withdrawal','Special Bonus','SOP'];
const LANG_LABELS={en:'EN',ms:'BM',zh:'中文'};
const icons={book:'<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15"/>',search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',arrow:'<path d="m9 5 7 7-7 7"/>',back:'<path d="m14 5-7 7 7 7"/>',copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',pin:'<path d="M9 3h6l-1 6 4 4H6l4-4-1-6ZM12 13v8"/>',check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',image:'<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',warn:'<path d="m12 3 10 18H2L12 3ZM12 9v5M12 17v1"/>'};
const icon=n=>`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[n]||icons.arrow}</svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const button=(a,t,cls='btn',attrs='')=>`<button type="button" data-action="${a}" class="${cls}" ${attrs}>${t}</button>`;
const guideById=id=>KB.guides.find(g=>g.id===id);
const storeKey='customer-approaching-knowledge-v2';
let saved={};try{saved=JSON.parse(localStorage.getItem(storeKey)||'{}')}catch(e){}
const S={open:null,pins:[],progress:saved.progress&&typeof saved.progress==='object'?saved.progress:{},recent:[],current:null,lang:['en','ms','zh'].includes(saved.lang)?saved.lang:'en',q:'',brand:'All',category:'All',categoryQuery:'',categorySearch:false,libraryScroll:0,zoom:1};
function persist(){try{localStorage.setItem(storeKey,JSON.stringify({pins:S.pins,progress:S.progress,recent:S.recent,current:S.current,lang:S.lang}))}catch(e){}}

const isLight=()=>{try{return parent.documentElement.dataset.theme==='light'}catch(e){return false}};
function syncTheme(){const light=isLight();app.classList.toggle('light',light);document.body.classList.toggle('light-page',light);try{document.documentElement.classList.toggle('low-power',parent.documentElement.classList.contains('low-power'))}catch(e){}}
try{new MutationObserver(syncTheme).observe(parent.documentElement,{attributes:true,attributeFilter:['data-theme','class']})}catch(e){}

/* ---- data ---- */
function normalizeGuide(g){
  const guide={...g};
  guide.steps=(g.steps||[]).map(s=>typeof s==='string'?{title:'',text:s}:s);
  guide.keywords=g.keywords||[];
  guide.scenarios=g.scenarios||[];
  guide.replies=g.replies||(g.example?{en:[g.example]}:{});
  if(!g.bonus_table&&Array.isArray(g.bonus_amounts)&&g.bonus_amounts.length)guide.bonus_table={title:'Bonus reference',cols:['Bonus'],rows:g.bonus_amounts.map(x=>[x])};
  guide.summary=g.summary||'';guide.brand=g.brand||'';
  return guide;
}
function buildCategories(){
  const names=[...new Set(KB.guides.map(g=>g.category).filter(Boolean))];
  const known=CATEGORY_ORDER.filter(n=>names.includes(n));
  const ordered=[...known,...names.filter(n=>!known.includes(n)).sort((a,b)=>a.localeCompare(b))];
  const used=new Set(ordered.map(n=>KNOWN_TONES[n]).filter(Boolean));
  KB.categories=ordered.map(name=>{
    if(KNOWN_TONES[name])return{name,color:KNOWN_TONES[name]};
    let hash=0;for(const ch of name.toLowerCase())hash=(hash*31+ch.charCodeAt(0))>>>0;
    let index=hash%TONES.length;for(let i=0;i<TONES.length&&used.has(TONES[index]);i++)index=(index+1)%TONES.length;
    used.add(TONES[index]);return{name,color:TONES[index]};
  });
}
function brandList(){const seen=new Map();for(const g of KB.guides)for(const part of (g.brand||'').split(/[\/&,]+/).map(x=>x.trim()).filter(Boolean)){const key=part.toLowerCase();if(!seen.has(key))seen.set(key,part)}return[...seen.values()]}
const hasUnsetBrand=()=>KB.guides.some(g=>!g.brand);
async function fromLark(){try{const res=await fetch('/knowledge-list');if(!res.ok)return null;const data=await res.json();return data&&data.ok&&data.configured&&Array.isArray(data.guides)?data.guides:null}catch(e){return null}}
async function load(){
  const guides=await fromLark()||await(await fetch('knowledge.json')).json();
  KB.guides=guides.map(normalizeGuide);buildCategories();
  S.pins=Array.isArray(saved.pins)?saved.pins.filter(guideById):[];
  S.recent=Array.isArray(saved.recent)?saved.recent.filter(guideById):[];
  S.current=guideById(saved.current)?saved.current:null;
  if(S.brand!=='All'&&S.brand!=='Not set'&&!brandList().includes(S.brand))S.brand='All';
}

/* ---- helpers ---- */
function done(g){const total=g.steps.length;const list=Array.isArray(S.progress[g.id])?S.progress[g.id].filter(i=>i<total):[];S.progress[g.id]=list;return list}
function matchesBrand(g){return S.brand==='All'||(S.brand==='Not set'?!g.brand:(g.brand||'').toLowerCase().includes(S.brand.toLowerCase()))}
function catColor(cat){return KB.categories.find(c=>c.name===cat)?.color||'cyan'}
function meta(g){return `<span class="meta" style="--cat:var(--${catColor(g.category)})"><span class="dot" aria-hidden="true"></span><span>${esc(g.category)}</span>${g.brand?`<span class="brand">${esc(g.brand)}</span>`:''}</span>`}
function row(g){return `<button type="button" class="result" data-action="open" data-id="${esc(g.id)}"><span class="result-main"><strong>${esc(g.title)}</strong>${meta(g)}</span><span class="arrow">${icon('arrow')}</span></button>`}
function rank(g,q){const t=q.toLowerCase(),words=t.match(/[\p{L}\p{N}]+/gu)||[];let score=0;const text=[g.title,g.category,g.summary,...g.keywords].join(' ').toLowerCase();for(const w of [...new Set(words)])if((w.length>2||/[㐀-鿿]/.test(w))&&text.includes(w))score+=1;if(g.title.toLowerCase().includes(t))score+=5;for(const k of g.keywords){const key=k.toLowerCase().trim();if(key.length>2&&t.includes(key))score+=4}return score}
function results(){return KB.guides.filter(g=>matchesBrand(g)&&(S.category==='All'||g.category===S.category)).map(g=>({g,score:rank(g,S.q.trim())})).filter(x=>!S.q.trim()||x.score>0).sort((a,b)=>b.score-a.score).map(x=>x.g)}
function scrolling(html){return `<div class="content-wrap"><div class="scroller" tabindex="0" aria-label="Knowledge content">${html}</div><div class="scroll-cue" hidden>More below ↓</div></div>`}

/* ---- library ---- */
function resume(){const g=guideById(S.current);if(!g||!matchesBrand(g)||!g.steps.length)return '';const n=done(g).length,total=g.steps.length;return `<button type="button" class="resume compact-resume" data-action="open" data-id="${esc(g.id)}"><span class="resume-copy"><span class="resume-eyebrow">Pick up where you left off</span><strong>${esc(g.title)}</strong><span class="resume-next">${n===total?'All steps marked done':'Continue the checklist'}</span></span><span class="resume-side"><span class="progress-ring" style="--done:${n/total*100}%"><span>${n}/${total}</span></span><span class="resume-link">Resume ${icon('arrow')}</span></span></button>`}
function tiles(){const cats=KB.categories.filter(c=>c.name.toLowerCase().includes(S.categoryQuery.toLowerCase()));return cats.length?`<div class="category-grid">${cats.map(c=>{const n=KB.guides.filter(g=>g.category===c.name&&matchesBrand(g)).length;return `<button type="button" class="category-tile" style="--cat:var(--${c.color})" data-action="category" data-category="${esc(c.name)}" aria-pressed="${S.category===c.name}">${esc(c.name)}<span class="category-count">${n} ${n===1?'guide':'guides'}</span></button>`}).join('')}</div>`:'<p class="muted small">No category found. Try fewer words.</p>'}
function browse(){const pins=S.pins.map(guideById).filter(matchesBrand);return `<div class="browse-content">${resume()}<div class="library-section-title">Pinned for you<span class="muted small">${pins.length} ${pins.length===1?'guide':'guides'}</span></div>${pins.length?`<div class="pinned-list">${pins.map(g=>`<div class="pin-card">${row(g)}${button('pin',icon('pin'),'icon-btn',`data-id="${esc(g.id)}" aria-label="Unpin ${esc(g.title)}" aria-pressed="true"`)}</div>`).join('')}</div>`:'<div class="pin-empty">Open a guide and select Pin to keep it here.</div>'}<div class="library-section-title">Browse categories${button('category-search',icon('search'),'icon-btn category-search-toggle',`aria-label="Find a category" aria-expanded="${S.categorySearch}"`)}</div><input type="search" class="query category-search" name="category-search" aria-label="Find a category" data-input="category-query" placeholder="Find a category…" value="${esc(S.categoryQuery)}" ${S.categorySearch?'':'hidden'}><div data-category-results>${tiles()}</div></div>`}
function resultList(){const rows=results();return `<div class="filtered-banner"><h3>${S.q?'Matching guides':S.category==='All'?'All guides':esc(S.category)}</h3>${S.q||S.category!=='All'?button('clear-filters','Clear filters','text-button'):`<span class="muted small">${rows.length}</span>`}</div>${rows.length?rows.map(row).join(''):`<div class="library-empty"><strong>${KB.guides.length?'No matching guides':'No guides yet'}</strong><p>${KB.guides.length?'Try fewer words or clear the category and brand filters.':'Guides added in Lark show up here.'}</p>${KB.guides.length?button('clear-filters','Show all guides'):''}</div>`}`}
function brandBar(){const brands=brandList();if(!brands.length&&!hasUnsetBrand())return '';const options=['All',...brands,...(brands.length&&hasUnsetBrand()?['Not set']:[])];return `<div class="brand-bar"><span class="muted small">Brand</span><div class="brand-segments" role="group" aria-label="Filter by brand">${options.map(b=>button('brand',b==='All'?'All brands':esc(b),'brand-segment',`data-brand="${esc(b)}" aria-pressed="${S.brand===b}"`)).join('')}</div></div>`}
function library(){const filtered=S.q||S.category!=='All';return `<div class="page-head"><div><h2>Knowledge</h2><p>SOPs and ready replies</p></div></div><div class="library-controls"><label class="field-label" for="guide-search">Find a guide</label><div class="query-wrap">${icon('search')}<input id="guide-search" name="search" type="search" class="query" data-input="query" placeholder="Search an issue or paste a message…" value="${esc(S.q)}" autocomplete="off"></div>${brandBar()}</div>${scrolling(`<div data-browse ${filtered?'hidden':''}>${browse()}</div><div data-results style="margin-top:${filtered?'0':'22px'}">${resultList()}</div>`)}`}

/* ---- guide ---- */
const hasReply=g=>Object.keys(g.replies).length>0;
function availableLang(g){return g.replies[S.lang]?S.lang:Object.keys(g.replies)[0]}
function sentences(g){const value=g.replies[availableLang(g)];return Array.isArray(value)?value:[value||'']}
function replyText(g){return sentences(g).join(availableLang(g)==='zh'?'':' ')}
function ph(text){return esc(text).replace(/\(([a-z ]+)\)/gi,'<b>($1)</b>')}
function replySection(g){if(!hasReply(g))return '';const lang=availableLang(g),langs=Object.keys(g.replies);return `<section class="doc-card reply-card"><div class="doc-card-head"><h2>Reply to member</h2>${langs.length>1?`<div class="reply-languages" role="group" aria-label="Reply language">${langs.map(l=>button('language',LANG_LABELS[l]||l,'',`data-lang="${l}" aria-pressed="${lang===l}"`)).join('')}</div>`:''}</div><div class="reply-bubbles">${sentences(g).map((s,i)=>`<button type="button" class="reply-bubble" data-action="copy-sentence" data-index="${i}" aria-label="Copy reply sentence ${i+1}"><span>${ph(s)}</span>${icon('copy')}</button>`).join('')}</div><p class="doc-tip">Tap a sentence to copy it.${/\([a-z ]+\)/i.test(replyText(g))?' Fill in the (brackets) before sending.':''}</p></section>`}
function detailedGuide(){const g=guideById(S.open),checked=done(g),bt=g.bonus_table;return `<div class="guide-navigation">${button('back',icon('back')+' Library','btn ghost')}${button('pin',icon('pin')+(S.pins.includes(g.id)?' Pinned':' Pin'),'icon-btn',`data-id="${esc(g.id)}" aria-pressed="${S.pins.includes(g.id)}"`)}</div>${scrolling(`<article class="guide-document"><header class="document-heading"><div class="document-badges"><span class="category-name">${esc(g.category)}</span>${g.brand?`<span>${esc(g.brand)}</span>`:''}</div><h1 tabindex="-1">${esc(g.title)}</h1>${g.summary?`<p>${esc(g.summary)}</p>`:''}</header>${g.steps.length?`<section class="doc-card"><div class="doc-card-head"><h2>Step-by-step</h2><span class="doc-progress" aria-live="polite">${checked.length} / ${g.steps.length} done</span></div><ol class="rtn-steps">${g.steps.map((s,i)=>`<li><button type="button" class="rtn-step" data-action="step" data-step="${i}" aria-pressed="${checked.includes(i)}"><span class="num">${checked.includes(i)?icon('check'):i+1}</span><span><strong>${esc(s.title||'Step '+(i+1))}</strong><span class="step-text">${esc(s.text)}</span></span></button></li>`).join('')}</ol><p class="doc-tip">Tap a step to tick it off while you handle the chat.</p></section>`:''}${bt?`<section class="doc-card"><div class="doc-card-head"><h2>${esc(bt.title||'Reference')}</h2></div><div class="doc-table-wrap"><table class="doc-table"><thead><tr>${bt.cols.map(c=>`<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${bt.rows.map(r=>`<tr>${r.map(c=>`<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`:''}${g.scenarios.length?`<section class="doc-card"><div class="doc-card-head"><h2>Scenarios</h2></div><div class="scenario-list">${g.scenarios.map(x=>`<div class="scenario ${x.ok?'yes':'no'}"><span class="scenario-symbol">${icon(x.ok?'check':'close')}</span><div><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p>${x.result?`<p class="outcome">${esc(x.result)}</p>`:''}</div></div>`).join('')}</div></section>`:''}${g.warning?`<aside class="doc-warning"><strong>${icon('warn')} Important</strong>${esc(g.warning)}</aside>`:''}${g.note?`<aside class="doc-note">${esc(g.note)}</aside>`:''}<div data-reply-section>${replySection(g)}</div></article>`)}${hasReply(g)||g.image?`<div class="actionbar">${hasReply(g)?`<div class="bar">${/\([a-z ]+\)/i.test(replyText(g))?'Fill in the reply placeholders before sending.':'Review the guide before sending the reply.'}</div>`:''}<div class="actions">${hasReply(g)?button('copy-all',icon('copy')+' Copy all','btn primary copy'):''}${g.image?button('picture',icon('image')+' Picture guide','btn picture-button'):''}</div></div>`:''}`}
function dialogMarkup(){return `<dialog class="picture-modal" aria-labelledby="picture-title" aria-describedby="picture-subtitle"><div class="modal-head"><div><h2 id="picture-title">Picture guide</h2><p id="picture-subtitle"></p></div>${button('close-picture',icon('close'),'icon-btn','aria-label="Close picture guide"')}</div><div class="image-window" tabindex="0" aria-label="Picture preview"><img class="picture-image" alt=""></div><div class="modal-foot"><span data-zoom-label>Fit to window</span><div class="zoom-controls">${button('zoom-out','−','btn','aria-label="Zoom out" disabled')}${button('zoom-fit','Fit','btn')}${button('zoom-in','+','btn','aria-label="Zoom in"')}</div></div></dialog>`}

/* ---- rendering ---- */
function render({keepScroll=false,focus=null}={}){const oldY=app.querySelector('.scroller')?.scrollTop||0;app.className=`widget app-frame ${isLight()?'light':''} ${S.open?'guide-open':''}`;document.body.classList.toggle('light-page',isLight());app.innerHTML=(S.open?detailedGuide():library())+dialogMarkup()+'<div class="toast" role="status" aria-live="polite" hidden></div>';const sc=app.querySelector('.scroller');if(keepScroll)sc.scrollTop=oldY;sc.addEventListener('scroll',cue);const dlg=app.querySelector('dialog');dlg.addEventListener('close',()=>{app.querySelector('[data-action="picture"]')?.focus({preventScroll:true})});dlg.addEventListener('click',e=>{if(e.target!==dlg)return;const b=dlg.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)dlg.close()});requestAnimationFrame(()=>{cue();if(focus)app.querySelector(focus)?.focus({preventScroll:true})})}
function cue(){const sc=app.querySelector('.scroller'),c=app.querySelector('.scroll-cue');if(sc&&c)c.hidden=sc.scrollHeight-sc.clientHeight-sc.scrollTop<15}
function refreshResults(){const browseBox=app.querySelector('[data-browse]');if(browseBox)browseBox.hidden=!!S.q||S.category!=='All';const target=app.querySelector('[data-results]');target.style.marginTop=S.q||S.category!=='All'?'0':'22px';target.innerHTML=resultList();cue()}
function openGuide(id){if(!guideById(id))return;S.libraryScroll=app.querySelector('.scroller')?.scrollTop||0;S.open=id;S.current=id;S.recent=[id,...S.recent.filter(x=>x!==id)].slice(0,4);persist();render({focus:'.document-heading h1'})}
function back(){S.open=null;render();app.querySelector('.scroller').scrollTop=S.libraryScroll;requestAnimationFrame(()=>{const scope=S.q||S.category!=='All'?'[data-results] ':'';app.querySelector(`${scope}[data-action="open"][data-id="${S.current}"]`)?.focus({preventScroll:true});cue()})}
let toastTimer;function toast(msg){const box=app.querySelector('.toast');box.textContent=msg;box.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{box.hidden=true},2800)}
async function copy(text){let ok=false;try{if(navigator.clipboard){await navigator.clipboard.writeText(text);ok=true}}catch(e){}if(!ok){const t=document.createElement('textarea');t.value=text;t.style.cssText='position:fixed;left:-9999px';document.body.append(t);t.select();try{ok=document.execCommand('copy')}catch(e){}t.remove()}toast(ok?'Reply copied':'Copy unavailable. Select the reply text and press Ctrl+C.');return ok}
let fitWidth=0;function showPicture(){const g=guideById(S.open);if(!g.image)return;const dlg=app.querySelector('dialog'),im=dlg.querySelector('img');S.zoom=1;dlg.querySelector('#picture-subtitle').textContent=g.title;im.alt='Picture guide: '+g.title;im.removeAttribute('style');dlg.querySelector('.image-window').classList.remove('zoomed');im.onload=()=>{fitWidth=im.getBoundingClientRect().width;zoomControls()};im.src=g.image;dlg.showModal();dlg.querySelector('[data-action="close-picture"]').focus();requestAnimationFrame(()=>{if(im.complete){fitWidth=im.getBoundingClientRect().width;zoomControls()}})}
function zoomControls(){const dlg=app.querySelector('dialog');dlg.querySelector('[data-zoom-label]').textContent=S.zoom===1?'Fit to window':`${Math.round(S.zoom*100)}% of fitted size`;dlg.querySelector('[data-action="zoom-out"]').disabled=S.zoom<=1;dlg.querySelector('[data-action="zoom-in"]').disabled=S.zoom>=4}
function zoom(value){S.zoom=Math.min(4,Math.max(1,value));const win=app.querySelector('.image-window'),im=win.querySelector('img');win.classList.toggle('zoomed',S.zoom>1);if(S.zoom===1){im.removeAttribute('style');win.scrollTop=0;win.scrollLeft=0}else{im.style.width=fitWidth*S.zoom+'px';im.style.height='auto'}zoomControls()}

app.addEventListener('click',async e=>{const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
 if(a==='open')openGuide(b.dataset.id);
 if(a==='back')back();
 if(a==='pin'){const id=b.dataset.id;S.pins=S.pins.includes(id)?S.pins.filter(x=>x!==id):[...S.pins,id];persist();render({keepScroll:true});toast(S.pins.includes(id)?'Guide pinned':'Guide unpinned')}
 if(a==='brand'){S.brand=b.dataset.brand;render({focus:`[data-brand="${CSS.escape(S.brand)}"]`})}
 if(a==='category'){S.category=b.dataset.category;render()}
 if(a==='category-search'){S.categorySearch=!S.categorySearch;render({keepScroll:true,focus:S.categorySearch?'[data-input="category-query"]':null})}
 if(a==='clear-filters'){S.q='';S.category='All';S.brand='All';render({focus:'#guide-search'})}
 if(a==='step'){const g=guideById(S.open),i=Number(b.dataset.step),arr=done(g),on=!arr.includes(i);S.progress[g.id]=on?[...arr,i]:arr.filter(x=>x!==i);b.setAttribute('aria-pressed',on);b.querySelector('.num').innerHTML=on?icon('check'):i+1;app.querySelector('.doc-progress').textContent=`${S.progress[g.id].length} / ${g.steps.length} done`;persist()}
 if(a==='language'){S.lang=b.dataset.lang;persist();app.querySelector('[data-reply-section]').innerHTML=replySection(guideById(S.open));app.querySelector(`[data-lang="${S.lang}"]`)?.focus();cue()}
 if(a==='copy-all')await copy(replyText(guideById(S.open)));
 if(a==='copy-sentence')await copy(sentences(guideById(S.open))[Number(b.dataset.index)]);
 if(a==='picture')showPicture();
 if(a==='close-picture')app.querySelector('dialog').close();
 if(a==='zoom-in')zoom(S.zoom+.5);
 if(a==='zoom-out')zoom(S.zoom-.5);
 if(a==='zoom-fit')zoom(1);
});
app.addEventListener('input',e=>{if(e.target.dataset.input==='query'){S.q=e.target.value;refreshResults()}if(e.target.dataset.input==='category-query'){S.categoryQuery=e.target.value;app.querySelector('[data-category-results]').innerHTML=tiles();cue()}});
document.addEventListener('keydown',e=>{if(app.querySelector('dialog')?.open)return;if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();if(S.open){S.open=null;render()}const box=app.querySelector('#guide-search');if(box){box.focus();box.select()}}if(e.key==='Escape'&&S.open){e.preventDefault();back()}if(e.key==='Enter'&&e.target.id==='guide-search'){const g=results()[0];if(g){e.preventDefault();openGuide(g.id)}}});
window.addEventListener('resize',cue);

app.className=`widget app-frame ${isLight()?'light':''}`;document.body.classList.toggle('light-page',isLight());
app.innerHTML='<div class="loading-note" role="status">Loading guides…</div>';
load().then(()=>render()).catch(()=>{app.innerHTML='<div class="loading-note" role="alert">Knowledge could not be loaded. Refresh and try again.</div>'});
