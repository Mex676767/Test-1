/* Admin-preview form for adding and editing guides. It writes to the Learning Group table through /knowledge-save. */
let F=null;
const MAX_PICTURE=5*1024*1024;
const blankGuide=()=>({id:'',title:'',category:'',newCategory:false,brand:'',summary:'',keywords:'',steps:[{title:'',text:''}],table:null,scenarios:[],warning:'',note:'',replies:{en:'',ms:'',zh:''},lang:'en',status:'Live',picture:null,previewUrl:'',existingImage:'',removePicture:false,saving:false,error:''});
function formFrom(g){
  const lines=l=>(g.replies[l]||[]).join('\n');
  return {...blankGuide(),id:g.id,title:g.title,category:g.category,brand:g.brand||'',summary:g.summary||'',keywords:(g.keywords||[]).join('\n'),
    steps:g.steps.length?g.steps.map(s=>({title:s.title||'',text:s.text||''})):[{title:'',text:''}],
    table:g.bonus_table?{cols:[...g.bonus_table.cols],rows:g.bonus_table.rows.map(r=>[...r])}:null,
    scenarios:g.scenarios.map(s=>({ok:s.ok!==false,title:s.title||'',text:s.text||'',result:s.result||''})),
    warning:g.warning||'',note:g.note||'',replies:{en:lines('en'),ms:lines('ms'),zh:lines('zh')},status:g.status==='Draft'?'Draft':'Live',existingImage:g.image||''};
}
const categoryChoices=()=>[...new Set([...(KB.options?.categories||[]),...KB.categories.map(c=>c.name)])];
const brandChoices=()=>KB.options?.brands?.length?KB.options.brands:[...new Set(KB.guides.map(g=>g.brand).filter(Boolean))];

/* ---- markup ---- */
const fInput=(path,val,ph='')=>`<input class="f-input" data-f="${path}" value="${esc(val)}" placeholder="${esc(ph)}" autocomplete="off">`;
const fArea=(path,val,rows,ph='')=>`<textarea class="f-area" data-f="${path}" rows="${rows}" placeholder="${esc(ph)}">${esc(val)}</textarea>`;
const fField=(label,inner,{hint='',req=false}={})=>`<label class="f-field"><span class="f-label">${label}${req?' <span class="f-req" aria-hidden="true">*</span>':''}</span>${inner}${hint?`<span class="f-hint">${hint}</span>`:''}</label>`;
const fSection=(title,body,tip='')=>`<section class="doc-card f-section"><div class="doc-card-head"><h2>${title}</h2></div>${tip?`<p class="f-hint f-tip">${tip}</p>`:''}${body}</section>`;
const fSeg=(action,items,current,label)=>`<div class="brand-segments" role="group" aria-label="${label}">${items.map(([value,text])=>button(action,text,'brand-segment',`data-value="${esc(value)}" aria-pressed="${String(current)===String(value)}"`)).join('')}</div>`;

function stepsBlock(){return F.steps.map((s,i)=>`<div class="f-repeat"><div class="f-repeat-head"><span class="f-num">${i+1}</span><div class="f-tools">${button('f-step-up','↑','icon-btn',`data-i="${i}" aria-label="Move step ${i+1} up" ${i===0?'disabled':''}`)}${button('f-step-down','↓','icon-btn',`data-i="${i}" aria-label="Move step ${i+1} down" ${i===F.steps.length-1?'disabled':''}`)}${button('f-step-del',icon('close'),'icon-btn',`data-i="${i}" aria-label="Remove step ${i+1}"`)}</div></div>${fInput(`steps.${i}.title`,s.title,'Step title, e.g. Check the valid period')}${fArea(`steps.${i}.text`,s.text,2,'What the agent should do')}</div>`).join('')+button('f-step-add','+ Add step','btn')}
function tableBlock(){
  if(!F.table)return `<p class="f-hint">For amounts, dates or requirements. Skip it if the guide has none.</p>${button('f-table-add','+ Add a table','btn')}`;
  const n=F.table.cols.length,cols=`style="grid-template-columns:repeat(${n},minmax(0,1fr)) 36px"`;
  return `<div class="f-grid f-grid-head" ${cols}>${F.table.cols.map((c,i)=>fInput(`table.cols.${i}`,c,`Heading ${i+1}`)).join('')}<span></span></div>${F.table.rows.map((r,ri)=>`<div class="f-grid" ${cols}>${F.table.cols.map((_,ci)=>fInput(`table.rows.${ri}.${ci}`,r[ci]||'','')).join('')}${button('f-row-del',icon('close'),'icon-btn',`data-r="${ri}" aria-label="Remove row ${ri+1}"`)}</div>`).join('')}<div class="f-tools f-wrap">${button('f-row-add','+ Row','btn')}${n<6?button('f-col-add','+ Column','btn'):''}${n>1?button('f-col-del','− Column','btn'):''}${button('f-table-del','Remove table','btn ghost')}</div>`;
}
function scenariosBlock(){return F.scenarios.map((s,i)=>`<div class="f-repeat"><div class="f-repeat-head">${fSeg('f-scn-ok',[['1','✓ Eligible / OK'],['0','✗ Not eligible']],s.ok?'1':'0',`Scenario ${i+1} outcome`).replace(/data-value=/g,`data-i="${i}" data-value=`)}${button('f-scn-del',icon('close'),'icon-btn',`data-i="${i}" aria-label="Remove scenario ${i+1}"`)}</div>${fInput(`scenarios.${i}.title`,s.title,'Title, e.g. Scenario 1 · Eligible to claim')}${fArea(`scenarios.${i}.text`,s.text,2,'The situation')}${fInput(`scenarios.${i}.result`,s.result,'What happens (the result)')}</div>`).join('')+button('f-scn-add','+ Add scenario','btn')}
function pictureBlock(){const src=F.previewUrl||(F.removePicture?'':F.existingImage);return `${src?`<img class="f-preview" src="${esc(src)}" alt="Picture preview">`:'<p class="f-hint">No picture yet.</p>'}<label class="f-field"><span class="f-label">${src?'Replace picture':'Upload a picture'}</span><input class="f-input" type="file" data-f="picture" accept="image/png,image/jpeg,image/webp"><span class="f-hint">PNG, JPEG or WebP, up to 5 MB.</span></label>${src?button('f-picture-remove','Remove picture','btn ghost'):''}`}
function formView(){
  const cats=categoryChoices(),brands=brandChoices(),known=cats.includes(F.category);
  const catSelect=`<select class="f-input" data-f="category-select">${F.newCategory||(F.category&&!known)?'':`<option value="" ${F.category?'':'selected'} disabled>Choose a category…</option>`}${cats.map(c=>`<option value="${esc(c)}" ${!F.newCategory&&F.category===c?'selected':''}>${esc(c)}</option>`).join('')}<option value="__new__" ${F.newCategory||(F.category&&!known)?'selected':''}>＋ New category…</option></select>`;
  const catField=fField('Category',catSelect,{req:true})+(F.newCategory||(F.category&&!known)?fField('New category name',fInput('category',F.category,'e.g. Escalation'),{hint:'It is added to the Category list in Lark when you save.'}):'');
  const brandField=brands.length?fField('Brand',`<select class="f-input" data-f="brand"><option value="">Not set (all brands)</option>${brands.map(b=>`<option value="${esc(b)}" ${F.brand===b?'selected':''}>${esc(b)}</option>`).join('')}</select>`):'';
  return `<div class="guide-navigation">${button('f-cancel',icon('back')+' Cancel','btn ghost')}<span class="muted small">${F.id?'Editing a guide':'New guide'}</span></div>${scrolling(`<div class="guide-document f-form">
<header class="document-heading"><h1 tabindex="-1">${F.id?'Edit guide':'Add a guide'}</h1><p>Fill in what applies. Anything you leave empty is hidden on the guide.</p></header>
${fSection('Basics',fField('Title',fInput('title',F.title,'e.g. Grace Period Bonus'),{req:true})+catField+brandField+fField('Summary',fArea('summary',F.summary,3,'One or two sentences about when to use this guide'))+fField('Keywords',fArea('keywords',F.keywords,3,'grace period\nactivate bonus\n激活红利'),{hint:'Words or phrases the player might write. One per line. Used by search.'}))}
${fSection('Step-by-step',stepsBlock(),'Each step has a short title and what to do. Agents tick steps off while they handle the chat.')}
${fSection('Reference table',tableBlock())}
${fSection('Scenarios',scenariosBlock(),'Worked examples, for example one that qualifies and one that does not.')}
${fSection('Important check and note',fField('Important check',fArea('warning',F.warning,3,'Shown in the yellow box'))+fField('Note',fArea('note',F.note,2,'e.g. New joiners: ask a Senior to issue it')))}
${fSection('Replies to the member',fSeg('f-lang',[['en','EN'],['ms','BM'],['zh','中文']],F.lang,'Reply language')+`<label class="f-field"><span class="f-label">Reply (${({en:'English',ms:'Malay',zh:'Chinese'})[F.lang]})</span>${fArea('reply',F.replies[F.lang],5,'One sentence per line. Agents tap a sentence to copy it.\nUse (brackets) where the agent must fill in a value, e.g. (amount).')}<span class="f-hint">${['en','ms','zh'].filter(l=>F.replies[l].trim()).map(l=>({en:'EN',ms:'BM',zh:'中文'})[l]).join(' · ')||'No reply written yet'} filled in.</span></label>`)}
${fSection('Picture guide',pictureBlock())}
${fSection('Who can see it',fSeg('f-status',[['Live','Live: agents see it'],['Draft','Draft: admin preview only']],F.status,'Visibility'),'A Draft shows only here in the admin preview, tagged Draft. Switch it to Live when you are happy with it.')}
</div>`)}<div class="actionbar">${F.error?`<p class="f-error" role="alert">${esc(F.error)}</p>`:''}<div class="actions">${button('f-save',F.saving?'Saving…':(F.id?'Save changes':'Save guide'),'btn primary copy',F.saving?'disabled':'')}${button('f-cancel','Cancel','btn picture-button',F.saving?'disabled':'')}</div></div>`;
}

/* ---- behaviour ---- */
function setPath(obj,path,value){const keys=path.split('.');let target=obj;for(let i=0;i<keys.length-1;i++)target=target[keys[i]];target[keys[keys.length-1]]=value}
function renderForm(focus=null){render({keepScroll:true,focus})}
function formInput(el){const path=el.dataset.f;if(path==='category-select'||path==='picture')return;if(path==='reply')F.replies[F.lang]=el.value;else setPath(F,path,el.value)}
function formChange(el){
  const path=el.dataset.f;
  if(path==='category-select'){if(el.value==='__new__'){F.newCategory=true;F.category='';renderForm('[data-f="category"]')}else{F.newCategory=false;F.category=el.value;renderForm()}return}
  if(path==='picture'){
    const file=el.files&&el.files[0];if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)){F.error='The picture must be a PNG, JPEG or WebP image.';el.value='';return renderForm()}
    if(file.size>MAX_PICTURE){F.error='The picture is too large (max 5 MB).';el.value='';return renderForm()}
    if(F.previewUrl)URL.revokeObjectURL(F.previewUrl);
    F.picture=file;F.previewUrl=URL.createObjectURL(file);F.removePicture=false;F.error='';renderForm();
  }
}
async function formAction(a,b){
  const i=Number(b.dataset.i),r=Number(b.dataset.r);
  if(a==='f-new'){F=blankGuide();S.view='form';render({focus:'[data-f="title"]'});return}
  if(a==='f-edit'){const g=guideById(b.dataset.id);if(!g)return;F=formFrom(g);S.view='form';render();return}
  if(a==='f-cancel'){if(F?.previewUrl)URL.revokeObjectURL(F.previewUrl);F=null;S.view=null;render();return}
  if(a==='f-save'){await saveGuide();return}
  if(a==='f-step-add'){F.steps.push({title:'',text:''});return renderForm(`[data-f="steps.${F.steps.length-1}.title"]`)}
  if(a==='f-step-del'){F.steps.splice(i,1);if(!F.steps.length)F.steps.push({title:'',text:''});return renderForm()}
  if(a==='f-step-up'&&i>0){[F.steps[i-1],F.steps[i]]=[F.steps[i],F.steps[i-1]];return renderForm()}
  if(a==='f-step-down'&&i<F.steps.length-1){[F.steps[i+1],F.steps[i]]=[F.steps[i],F.steps[i+1]];return renderForm()}
  if(a==='f-table-add'){F.table={cols:['Item','Value'],rows:[['','']]};return renderForm('[data-f="table.rows.0.0"]')}
  if(a==='f-table-del'){F.table=null;return renderForm()}
  if(a==='f-row-add'){F.table.rows.push(F.table.cols.map(()=>''));return renderForm(`[data-f="table.rows.${F.table.rows.length-1}.0"]`)}
  if(a==='f-row-del'){F.table.rows.splice(r,1);return renderForm()}
  if(a==='f-col-add'&&F.table.cols.length<6){F.table.cols.push('');F.table.rows.forEach(row=>row.push(''));return renderForm(`[data-f="table.cols.${F.table.cols.length-1}"]`)}
  if(a==='f-col-del'&&F.table.cols.length>1){F.table.cols.pop();F.table.rows.forEach(row=>row.pop());return renderForm()}
  if(a==='f-scn-add'){F.scenarios.push({ok:true,title:'',text:'',result:''});return renderForm(`[data-f="scenarios.${F.scenarios.length-1}.title"]`)}
  if(a==='f-scn-del'){F.scenarios.splice(i,1);return renderForm()}
  if(a==='f-scn-ok'){F.scenarios[i].ok=b.dataset.value==='1';return renderForm()}
  if(a==='f-lang'){F.lang=b.dataset.value;return renderForm('[data-f="reply"]')}
  if(a==='f-status'){F.status=b.dataset.value;return renderForm()}
  if(a==='f-picture-remove'){if(F.previewUrl)URL.revokeObjectURL(F.previewUrl);F.picture=null;F.previewUrl='';F.removePicture=true;return renderForm()}
}
async function saveGuide(){
  if(!F||F.saving)return;
  const title=F.title.trim(),category=F.category.trim();
  if(!title){F.error='Give the guide a title.';return renderForm('[data-f="title"]')}
  if(!category){F.error='Choose a category, or add a new one.';return renderForm(F.newCategory?'[data-f="category"]':'[data-f="category-select"]')}
  F.saving=true;F.error='';renderForm();
  const guide={id:F.id,title,category,brand:F.brand,summary:F.summary,keywords:F.keywords,steps:F.steps,table:F.table,scenarios:F.scenarios,warning:F.warning,note:F.note,replies:F.replies,status:F.status,removePicture:F.removePicture};
  const body=new FormData();body.set('guide',JSON.stringify(guide));if(F.picture)body.set('picture',F.picture);
  try{
    const res=await fetch('/knowledge-save',{method:'POST',body}),data=await res.json().catch(()=>({}));
    if(!res.ok||!data.ok)throw new Error(data.error||'Saving failed. Try again.');
    if(F.previewUrl)URL.revokeObjectURL(F.previewUrl);
    await load();F=null;S.view=null;
    if(guideById(data.id))openGuide(data.id);else render();
    toast(data.created?'Guide added':'Guide saved');
  }catch(err){
    F.saving=false;F.error=String(err.message||err);renderForm();
    app.querySelector('.f-error')?.scrollIntoView({block:'nearest'});
  }
}
