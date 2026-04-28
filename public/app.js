// ══════════════════════════════════════════════════════════════════════
// State
// ══════════════════════════════════════════════════════════════════════
let library=[],currentView='home',currentMedia=null,controlsTimeout=null,progressSaveInterval=null;
let folderConfig=[],activeProfile=null,profileQueue=[];
let skipInterval=10,playbackSpeed=1,watchFilter='all';
let _currentQuality='auto'; // 'low', 'auto', 'high'
let dismissedItems={continueWatching:{},recentlyAdded:{}};
let currentRole='user'; // 'admin' or 'user'
let currentPermissions=[]; // ['canDownload','canScan','canRestart','canLogs']
function hasPerm(p){return currentRole==='admin'||currentPermissions.includes(p);}
// Admin auth is handled via HttpOnly cookie — no token in JS needed
function adminHeaders(){return{'Content-Type':'application/json'};}
async function adminFetch(url,opts={}){
  opts.credentials='same-origin';
  const r=await fetch(url,opts);
  if(r.status===401||(r.status===403&&currentRole==='admin')){
    // adminSession cookie is stale (server restarted) — force full re-login
    await fetch('/api/logout',{method:'POST',credentials:'same-origin'});
    activeProfile=null;currentRole='user';currentPermissions=[];
    const app=document.getElementById('appContainer');
    const profile=document.getElementById('profileScreen');
    if(app)app.style.display='none';
    if(profile)profile.style.display='flex';
    if(typeof showToast==='function')showToast('Session expired — please log in again');
  }
  return r;
}

function updateSystemVisibility(){
  const isAdmin=currentRole==='admin';
  const showDownloads=isAdmin||currentPermissions.includes('canDownload');
  const showSettings=isAdmin; // settings/folders always admin-only
  const showScan=isAdmin||currentPermissions.includes('canScan');
  const showRestart=isAdmin||currentPermissions.includes('canRestart');
  const showLogs=isAdmin||currentPermissions.includes('canLogs');
  const showSystem=showDownloads||showSettings||showScan||showRestart||showLogs||isAdmin;
  const el=document.getElementById('systemSection');
  if(el){showSystem?el.classList.add('visible'):el.classList.remove('visible');}
  const ndash=document.getElementById('navSystem');if(ndash)ndash.style.display=isAdmin?'':'none';
  const nd=document.getElementById('navDownloads');if(nd)nd.style.display=showDownloads?'':'none';
  const nl=document.getElementById('navLogs');if(nl)nl.style.display=showLogs?'':'none';
  const nol=document.getElementById('navOrgLogs');if(nol)nol.style.display=isAdmin?'':'none';
  const ns=document.getElementById('navSettings');if(ns)ns.style.display=showSettings?'':'none';
  const nsc=document.getElementById('navScan');if(nsc)nsc.style.display=showScan?'':'none';
  const nr=document.getElementById('navRestart');if(nr)nr.style.display=showRestart?'':'none';
}

const V=document.getElementById('videoElement'),modal=document.getElementById('playerModal');
const progContainer=document.getElementById('progressContainer');
const _isTouch=('ontouchstart' in window)||navigator.maxTouchPoints>0;
let hlsInstance=null;
window._hlsSeekOffset=0;
let audioBoostLevel=1;
let audioBoostContext=null,audioBoostSource=null,audioBoostGain=null,audioBoostError='';
window._audioBoostGainNode=null;
window._audioBoostLevel=audioBoostLevel;

// ══════════════════════════════════════════════════════════════════════
// Profiles
// ══════════════════════════════════════════════════════════════════════
async function loadProfiles(){
  const res=await fetch('/api/profiles');
  return res.json();
}

async function checkExistingSession(){
  try{
    const res=await fetch('/api/me');
    const data=await res.json();
    if(data.loggedIn){
      activeProfile=data.profileId;
      currentRole=data.role||'user';
      currentPermissions=data.permissions||[];
      _currentQuality=data.quality||'auto';
      updateQualityUI();
      return true;
    }
  }catch{}
  return false;
}

async function showProfileScreen(skipSessionCheck){
  // Check for existing session first (skip if user clicked "Switch")
  if(!skipSessionCheck&&await checkExistingSession()){
    document.getElementById('profileScreen').style.display='none';
    document.getElementById('appContainer').style.display='';
    updateSystemVisibility();
    nav('home',document.querySelector('[data-view="home"]'));
    const profiles=await loadProfiles();
    const p=profiles.find(x=>x.id===activeProfile);
    if(p){
      document.getElementById('sidebarAvatar').style.background=p.avatar;
      document.getElementById('sidebarAvatar').textContent=p.name[0].toUpperCase();
      document.getElementById('sidebarName').textContent=p.name;
    }
    await Promise.all([fetchLib(),fetchDismissed()]);
    renderView();
    await fetchQueue();
    setupSSE();
    if(hasPerm('canDownload'))dlFetchPlugins();
    return;
  }

  // Show login form
  document.getElementById('profileScreen').style.display='';
  document.getElementById('appContainer').style.display='none';
  const u=document.getElementById('loginUsername');
  const p=document.getElementById('loginPassword');
  if(u)u.value='';
  if(p)p.value='';
  document.getElementById('loginError').textContent='';
  setTimeout(()=>{if(u)u.focus();},100);
}

// Handle Enter key in login form
document.getElementById('loginUsername').addEventListener('keydown',e=>{if(e.key==='Enter'){document.getElementById('loginPassword').focus();}});
document.getElementById('loginPassword').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin();});

async function doLogin(){
  const username=document.getElementById('loginUsername').value.trim();
  const password=document.getElementById('loginPassword').value;
  const err=document.getElementById('loginError');
  if(!username){err.textContent='Enter your username';return;}
  if(!password){err.textContent='Enter your password';return;}
  try{
    const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const data=await res.json();
    if(!res.ok){
      err.textContent=data.error||'Login failed';
      document.getElementById('loginPassword').value='';
      document.getElementById('loginPassword').focus();
      return;
    }
    activeProfile=data.profileId;
    currentRole=data.role||'user';
    currentPermissions=data.permissions||[];
    document.getElementById('profileScreen').style.display='none';
    document.getElementById('appContainer').style.display='';
    updateSystemVisibility();
    nav('home',document.querySelector('[data-view="home"]'));
    const profiles=await loadProfiles();
    const p=profiles.find(x=>x.id===data.profileId);
    if(p){
      document.getElementById('sidebarAvatar').style.background=p.avatar;
      document.getElementById('sidebarAvatar').textContent=p.name[0].toUpperCase();
      document.getElementById('sidebarName').textContent=p.name;
    }
    await Promise.all([fetchLib(),fetchDismissed()]);
    renderView();
    await fetchQueue();
    setupSSE();
    if(hasPerm('canDownload'))dlFetchPlugins();
  }catch(e){
    err.textContent='Connection error';
  }
}

const AVATAR_COLORS=['#38bdf8','#22d3ee','#6366f1','#a78bfa','#14b8a6','#4ade80','#f43f5e','#64748b'];
let _selectedAvatar=AVATAR_COLORS[0];

function closeModal(){
  const overlay=document.getElementById('modalOverlay');
  overlay.classList.remove('active');
  setTimeout(()=>{overlay.innerHTML='';},200);
}

function openModal(html){
  const overlay=document.getElementById('modalOverlay');
  overlay.innerHTML=`<div class="modal-dialog">${html}</div>`;
  requestAnimationFrame(()=>overlay.classList.add('active'));
}

function createProfile(){
  _selectedAvatar=AVATAR_COLORS[Math.floor(Math.random()*AVATAR_COLORS.length)];
  openModal(`
    <h2>Create Profile</h2>
    <div class="modal-field">
      <label>Display Name</label>
      <input type="text" id="modalName" placeholder="Enter name" autofocus>
    </div>
    <div class="modal-field">
      <label>Username</label>
      <input type="text" id="modalUsername" placeholder="Login username" autocomplete="off">
      <div class="field-hint">Used to sign in (auto-generated from name if empty)</div>
    </div>
    <div class="modal-field">
      <label>Password</label>
      <input type="password" id="modalPassword" placeholder="Required">
    </div>
    <div class="modal-field">
      <label>Role</label>
      <select id="modalRole" onchange="togglePermissions()">
        <option value="user">User — browse &amp; watch only</option>
        <option value="admin">Admin — full system access</option>
      </select>
    </div>
    <div class="modal-field" id="permissionsField" style="display:block">
      <label>Permissions</label>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:6px">
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permDownload').click()"><input type="checkbox" id="permDownload" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Downloads — search &amp; manage torrents</span></div>
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permScan').click()"><input type="checkbox" id="permScan" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Scan Library — trigger media rescans</span></div>
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permRestart').click()"><input type="checkbox" id="permRestart" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Restart Server</span></div>
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permLogs').click()"><input type="checkbox" id="permLogs" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Logs — view watch activity &amp; now watching</span></div>
      </div>
    </div>
    <div class="modal-field">
      <label>Avatar Color</label>
      <div class="avatar-picker" id="avatarPicker">
        ${AVATAR_COLORS.map(c=>`<div class="avatar-option${c===_selectedAvatar?' selected':''}" style="background:${c}" onclick="pickAvatar('${c}',this)"></div>`).join('')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" onclick="submitCreateProfile()">Create</button>
    </div>
  `);
  setTimeout(()=>{const el=document.getElementById('modalName');if(el)el.focus();},100);
}

function pickAvatar(color,el){
  _selectedAvatar=color;
  document.querySelectorAll('#avatarPicker .avatar-option').forEach(e=>e.classList.remove('selected'));
  el.classList.add('selected');
}

function togglePermissions(){
  const role=document.getElementById('modalRole').value;
  const pf=document.getElementById('permissionsField');
  if(pf) pf.style.display=role==='admin'?'none':'block';
}

function getSelectedPermissions(){
  const perms=[];
  if(document.getElementById('permDownload')?.checked) perms.push('canDownload');
  if(document.getElementById('permScan')?.checked) perms.push('canScan');
  if(document.getElementById('permRestart')?.checked) perms.push('canRestart');
  if(document.getElementById('permLogs')?.checked) perms.push('canLogs');
  return perms;
}

async function submitCreateProfile(){
  const name=document.getElementById('modalName').value.trim();
  if(!name){document.getElementById('modalName').style.borderColor='#e5484d';return;}
  const username=document.getElementById('modalUsername').value.trim();
  const password=document.getElementById('modalPassword').value;
  const role=document.getElementById('modalRole').value;
  const permissions=role==='admin'?[]:getSelectedPermissions();
  if(!password){document.getElementById('modalPassword').style.borderColor='#e5484d';return;}
  closeModal();
  await adminFetch('/api/profiles',{method:'POST',headers:adminHeaders(),body:JSON.stringify({name,username:username||'',password,role,avatar:_selectedAvatar,permissions})});
  if(currentView==='settings')renderSettings();
  else showProfileScreen(true);
}

async function editAccount(profileId){
  const profiles=await loadProfiles();
  const p=profiles.find(x=>x.id===profileId);
  if(!p)return;
  _selectedAvatar=p.avatar||AVATAR_COLORS[0];
  const perms=p.permissions||[];
  const isAdmin=p.role==='admin';
  openModal(`
    <h2>Edit Account</h2>
    <div class="modal-field">
      <label>Display Name</label>
      <input type="text" id="modalName" value="${esc(p.name)}" autofocus>
    </div>
    <div class="modal-field">
      <label>Username</label>
      <input type="text" id="modalUsername" value="${esc(p.username||'')}" autocomplete="off">
    </div>
    <div class="modal-field">
      <label>New Password</label>
      <input type="password" id="modalPassword" placeholder="Leave empty to keep current">
      <div class="field-hint">Only fill in to change the password</div>
    </div>
    <div class="modal-field">
      <label>Role</label>
      <select id="modalRole" onchange="togglePermissions()">
        <option value="user"${!isAdmin?' selected':''}>User — browse &amp; watch only</option>
        <option value="admin"${isAdmin?' selected':''}>Admin — full system access</option>
      </select>
    </div>
    <div class="modal-field" id="permissionsField" style="display:${isAdmin?'none':'block'}">
      <label>Permissions</label>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:6px">
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permDownload').click()"><input type="checkbox" id="permDownload" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"${perms.includes('canDownload')?' checked':''}><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Downloads — search &amp; manage torrents</span></div>
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permScan').click()"><input type="checkbox" id="permScan" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"${perms.includes('canScan')?' checked':''}><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Scan Library — trigger media rescans</span></div>
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permRestart').click()"><input type="checkbox" id="permRestart" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"${perms.includes('canRestart')?' checked':''}><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Restart Server</span></div>
        <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="document.getElementById('permLogs').click()"><input type="checkbox" id="permLogs" style="width:18px;height:18px;flex-shrink:0;accent-color:var(--accent)" onclick="event.stopPropagation()"${perms.includes('canLogs')?' checked':''}><span style="font-size:.85rem;color:var(--text-primary);text-transform:none;letter-spacing:0;font-weight:400">Logs — view watch activity &amp; now watching</span></div>
      </div>
    </div>
    <div class="modal-field">
      <label>Avatar Color</label>
      <div class="avatar-picker" id="avatarPicker">
        ${AVATAR_COLORS.map(c=>`<div class="avatar-option${c===_selectedAvatar?' selected':''}" style="background:${c}" onclick="pickAvatar('${c}',this)"></div>`).join('')}
      </div>
    </div>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" onclick="submitEditAccount('${profileId}')">Save</button>
    </div>
  `);
  setTimeout(()=>{const el=document.getElementById('modalName');if(el)el.focus();},100);
}

async function submitEditAccount(profileId){
  const name=document.getElementById('modalName').value.trim();
  if(!name){document.getElementById('modalName').style.borderColor='#e5484d';return;}
  const username=document.getElementById('modalUsername').value.trim();
  const password=document.getElementById('modalPassword').value;
  const role=document.getElementById('modalRole').value;
  const permissions=role==='admin'?[]:getSelectedPermissions();
  const body={name,username,role,avatar:_selectedAvatar,permissions};
  if(password) body.password=password; // only update password if provided
  closeModal();
  await adminFetch('/api/profiles/'+profileId,{method:'PUT',headers:adminHeaders(),body:JSON.stringify(body)});
  if(currentView==='settings')renderSettings();
}

async function deleteAccount(profileId,name){
  openModal(`
    <h2>Delete Account</h2>
    <p style="color:var(--text-secondary);text-align:center;margin-bottom:8px">Are you sure you want to delete <strong>${esc(name)}</strong>?</p>
    <p style="color:var(--text-muted);font-size:.8rem;text-align:center">This will delete all their watch history and progress.</p>
    <div class="modal-actions">
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
      <button class="btn-confirm" style="background:#e5484d" onclick="confirmDeleteAccount('${escAttr(profileId)}')">Delete</button>
    </div>
  `);
}

async function confirmDeleteAccount(profileId){
  closeModal();
  await adminFetch('/api/profiles/'+profileId,{method:'DELETE',headers:adminHeaders()});
  if(currentView==='settings')renderSettings();
}

async function switchProfile(){
  await fetch('/api/logout',{method:'POST'});
  activeProfile=null;
  currentRole='user';
  showProfileScreen(true);
}

// ══════════════════════════════════════════════════════════════════════
// Data fetching
// ══════════════════════════════════════════════════════════════════════
async function fetchLib(){
  try{
    const res=await fetch(`/api/library?profile=${activeProfile}`);
    library=await res.json();
    updateStats();
    updateCustomNav();
    if(currentView!=='settings')renderView();
  }catch{
    document.getElementById('contentArea').innerHTML='<div class="empty-state"><div class="empty-icon">&#9888;&#65039;</div><div class="empty-title">Connection Error</div></div>';
  }
}

async function fetchConfig(){
  try{const r=await adminFetch('/api/config');folderConfig=r.ok?await r.json():[];}catch{folderConfig=[];}
}

async function fetchQueue(){
  try{
    profileQueue=await(await fetch(`/api/queue?profile=${activeProfile}`)).json();
    const badge=document.getElementById('queueBadge');
    if(profileQueue.length>0){badge.style.display='';badge.textContent=profileQueue.length;}
    else badge.style.display='none';
  }catch{profileQueue=[];}
}

async function fetchDismissed(){
  try{dismissedItems=await(await fetch(`/api/dismissed?profile=${activeProfile}`)).json();}
  catch{dismissedItems={continueWatching:{},recentlyAdded:{}};}
}

function getCustomTypes(){
  const types=new Set();
  for(const item of library){if(item.type!=='movie'&&item.type!=='show')types.add(item.type);}
  return [...types].sort();
}

function customTypeLabel(type){
  return type.charAt(0).toUpperCase()+type.slice(1);
}

function customTypeIcon(type){
  const icons={anime:'あ',documentary:'▣',documentaries:'▣',sports:'●',music:'♪',kids:'☆',reality:'▤',standup:'◌',comedy:'◡'};
  return icons[type]||'▱';
}

function updateCustomNav(){
  const container=document.getElementById('customNavItems');
  if(!container)return;
  const types=getCustomTypes();
  if(!types.length){container.innerHTML='';return;}
  container.innerHTML=types.map(t=>`<button class="nav-item" data-view="custom_${t}" onclick="nav('custom_${t}',this)"><span class="nav-icon">${customTypeIcon(t)}</span> ${customTypeLabel(t)}</button>`).join('');
}

function updateStats(){
  const m=library.filter(i=>i.type==='movie').length,s=library.filter(i=>i.type==='show').length;
  const custom=getCustomTypes();
  const extra=custom.map(t=>{const c=library.filter(i=>i.type===t).length;return `${c} ${customTypeLabel(t).toLowerCase()}`;}).join(' · ');
  document.getElementById('libraryStats').textContent=`${library.length} items · ${m} movies · ${s} shows${extra?' · '+extra:''}`;
  document.getElementById('libCount').textContent=`${library.length} items`;
}

function activateWithKeyboard(event){
  if(event.key==='Enter'||event.key===' '){
    event.preventDefault();
    event.currentTarget.click();
  }
}

function updateLayoutChrome(view){
  const hideTopBar=view==='settings'||view==='showDetail'||view==='downloads'||view==='system'||view==='logs'||view==='orglogs';
  document.getElementById('topBar').style.display=hideTopBar?'none':'';
  document.body.classList.toggle('top-bar-hidden',hideTopBar);
  document.body.dataset.view=view;
}

function updateSidebarState(isOpen){
  const sidebar=document.getElementById('sidebar');
  const overlay=document.getElementById('sidebarOverlay');
  const hamburger=document.querySelector('.hamburger');
  sidebar.classList.toggle('open',isOpen);
  overlay.classList.toggle('open',isOpen);
  if(hamburger){
    hamburger.setAttribute('aria-expanded',String(isOpen));
    hamburger.setAttribute('aria-label',isOpen?'Close navigation menu':'Open navigation menu');
  }
}

function updateFilterButtons(){
  document.querySelectorAll('.filter-btn').forEach(btn=>{
    const active=btn.id===`filter${watchFilter.charAt(0).toUpperCase()+watchFilter.slice(1)}Btn`;
    btn.classList.toggle('active',active);
    btn.setAttribute('aria-pressed',active?'true':'false');
  });
}

// SSE for live updates
function setupSSE(){
  const es=new EventSource('/api/events');
  es.addEventListener('library-updated',()=>{fetchLib();});
}

// ══════════════════════════════════════════════════════════════════════
// Navigation & Rendering
// ══════════════════════════════════════════════════════════════════════
function nav(view,btn){
  currentView=view;
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  if(btn)btn.classList.add('active');
  document.getElementById('searchInput').value='';
  updateLayoutChrome(view);
  renderView();
  updateSidebarState(false);
}

function toggleSidebar(forceState){
  const sidebar=document.getElementById('sidebar');
  const nextState=typeof forceState==='boolean'?forceState:!sidebar.classList.contains('open');
  updateSidebarState(nextState);
}

function renderView(){
  const a=document.getElementById('contentArea');
  switch(currentView){
    case 'home':a.innerHTML=renderHome();break;
    case 'movies':a.innerHTML=renderPaginatedGrid('movie','Movies');setupGridObserver('movie');break;
    case 'shows':a.innerHTML=renderShowsView();break;
    case 'continue':a.innerHTML=renderContinue();break;
    case 'queue':a.innerHTML=renderQueue();break;
    case 'history':renderHistory();return;
    case 'system':if(currentRole!=='admin'){nav('home',document.querySelector('[data-view="home"]'));return;}renderAdminDashboard();return;
    case 'settings':if(currentRole!=='admin'){nav('home',document.querySelector('[data-view="home"]'));return;}renderSettings();return;
    case 'downloads':if(!hasPerm('canDownload')){nav('home',document.querySelector('[data-view="home"]'));return;}renderDownloads();return;
    case 'logs':if(currentRole!=='admin'&&!hasPerm('canLogs')){nav('home',document.querySelector('[data-view="home"]'));return;}renderLogs();return;
    case 'orglogs':if(currentRole!=='admin'){nav('home',document.querySelector('[data-view="home"]'));return;}renderOrgLogsPage();return;
    case 'showDetail':a.innerHTML=renderShowDetail(currentShowName);break;
    default:
      if(currentView.startsWith('custom_')){
        const typeName=currentView.slice(7);
        const items=library.filter(m=>m.type===typeName);
        const hasShows=items.some(i=>i.showName);
        if(hasShows){
          a.innerHTML=renderCustomTypeView(typeName);
        }else{
          const label=customTypeLabel(typeName);
          a.innerHTML=renderPaginatedGrid(typeName,label);
          setupGridObserver(typeName);
        }
      }
      break;
  }
}

function renderCustomTypeView(typeName){
  const items=library.filter(m=>m.type===typeName);
  const label=customTypeLabel(typeName);
  if(!items.length)return `<div class="empty-state"><div class="empty-icon">${customTypeIcon(typeName)}</div><div class="empty-title">No ${label} Found</div><div class="empty-text">Link a folder with type "${typeName}" in settings.</div></div>`;

  // Check if items have showNames (series-like) — group them
  const hasShows=items.some(i=>i.showName);
  if(hasShows){
    const shows={};
    for(const item of items){
      const name=item.showName||item.title;
      if(!shows[name])shows[name]={name,items:[],poster:null,year:null,imdbRating:null,watched:true};
      shows[name].items.push(item);
      if(!shows[name].poster)shows[name].poster=item.omdbPosterUrl||item.posterUrl||null;
      if(!shows[name].year&&item.year)shows[name].year=item.year;
      if(!shows[name].imdbRating&&item.imdbRating)shows[name].imdbRating=item.imdbRating;
      if(!item.watched)shows[name].watched=false;
    }
    let showList=Object.values(shows);
    if(watchFilter==='watched')showList=showList.filter(s=>s.watched);
    if(watchFilter==='unwatched')showList=showList.filter(s=>!s.watched);
    const s=document.getElementById('sortSelect').value;
    switch(s){
      case 'title-asc':showList.sort((a,b)=>a.name.localeCompare(b.name));break;
      case 'title-desc':showList.sort((a,b)=>b.name.localeCompare(a.name));break;
      case 'year-desc':showList.sort((a,b)=>(b.year||0)-(a.year||0));break;
      case 'year-asc':showList.sort((a,b)=>(a.year||9999)-(b.year||9999));break;
      case 'rating-desc':showList.sort((a,b)=>(parseFloat(b.imdbRating)||0)-(parseFloat(a.imdbRating)||0));break;
      default:showList.sort((a,b)=>a.name.localeCompare(b.name));
    }
    if(!showList.length)return `<div class="empty-state"><div class="empty-icon">${customTypeIcon(typeName)}</div><div class="empty-title">No ${label} Found</div></div>`;
    const cards=showList.map(s=>{
      const ep=s.items.length;
      const first=firstEpisode(s.items);
      const poster=s.poster?`<img src="${s.poster}" alt="${esc(s.name)} poster" loading="lazy">`:`<div class="card-placeholder">${customTypeIcon(typeName)}</div>`;
      return `<div class="card media-card" onclick="openShow('${escAttr(s.name)}','${escAttr(typeName)}')" onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="Open ${escAttr(s.name)}"><div class="card-poster">${poster}<div class="card-overlay"><button class="card-play-btn" onclick="event.stopPropagation();playMedia('${first.id}')" aria-label="Play ${escAttr(s.name)}"><span class="play-icon">&#9654;</span><span>Play</span></button></div></div><div class="card-info"><div class="card-title">${esc(s.name)}</div><div class="card-year">${ep} episode${ep>1?'s':''}</div><span class="card-type show">${label}</span></div></div>`;
    });
    return `<div class="section"><div class="section-header"><h2 class="section-title">${label} (${showList.length})</h2></div><div class="grid">${cards.join('')}</div></div>`;
  }

  // Flat grid (movie-like)
  const filtered=getFiltered(items);
  return `<div class="section"><div class="section-header"><h2 class="section-title">${label} (${filtered.length})</h2></div><div class="grid">${filtered.map(card).join('')}</div></div>`;
}

// ── Sorting & filtering helpers ────────────────────────────────────────
function getFiltered(items){
  let f=items;
  if(watchFilter==='watched')f=f.filter(i=>i.watched);
  if(watchFilter==='unwatched')f=f.filter(i=>!i.watched);
  return sortItems(f);
}

function sortItems(items){
  const s=document.getElementById('sortSelect').value;
  const copy=[...items];
  switch(s){
    case 'title-asc':return copy.sort((a,b)=>a.title.localeCompare(b.title));
    case 'title-desc':return copy.sort((a,b)=>b.title.localeCompare(a.title));
    case 'year-desc':return copy.sort((a,b)=>(b.year||0)-(a.year||0));
    case 'year-asc':return copy.sort((a,b)=>(a.year||9999)-(b.year||9999));
    case 'recent':return copy.sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  }
  return copy;
}

function setFilter(f){
  watchFilter=f;
  updateFilterButtons();
  renderView();
}

function openHeroStat(target){
  const topViews=['home','movies','shows','continue'];
  if(target==='unwatched'){
    watchFilter='unwatched';
    updateFilterButtons();
    nav('movies',document.querySelector('[data-view="movies"]'));
    return;
  }
  if(topViews.includes(target)){
    if(target==='movies'||target==='shows')watchFilter='all';
    updateFilterButtons();
    nav(target,document.querySelector(`[data-view="${target}"]`));
  }
}

// ── Home ───────────────────────────────────────────────────────────────
function mediaTypeLabel(item){
  if(item.type==='movie')return 'Movie';
  if(item.type==='show')return 'TV Show';
  return customTypeLabel(item.type);
}

function mediaMetaLine(item){
  const parts=[];
  if(item.year)parts.push(item.year);
  if(item.epInfo)parts.push(`S${item.epInfo.season||1} E${item.epInfo.episode||1}`);
  parts.push(mediaTypeLabel(item));
  if(item.imdbRating)parts.push('IMDb '+item.imdbRating);
  if(item.progress?.percent>0)parts.push(item.progress.percent+'% watched');
  return parts.join(' · ');
}

function getNextEpisodes(){
  const episodes=library.filter(m=>m.type==='show'&&!m.watched);
  episodes.sort((a,b)=>{
    const an=a.showName||a.title||'',bn=b.showName||b.title||'';
    const showSort=an.localeCompare(bn);
    if(showSort)return showSort;
    const seasonSort=(a.epInfo?.season||0)-(b.epInfo?.season||0);
    if(seasonSort)return seasonSort;
    return (a.epInfo?.episode||0)-(b.epInfo?.episode||0);
  });
  const seen=new Set(),next=[];
  for(const item of episodes){
    const key=item.showName||item.title;
    if(seen.has(key))continue;
    seen.add(key);
    next.push(item);
    if(next.length>=18)break;
  }
  return next;
}

function getSmartPicks(){
  return library.filter(m=>!m.watched)
    .sort((a,b)=>(parseFloat(b.imdbRating)||0)-(parseFloat(a.imdbRating)||0)||(b.addedAt||0)-(a.addedAt||0))
    .slice(0,18);
}

function renderHomeDashboard(extraClass=''){
  const movies=library.filter(m=>m.type==='movie').length;
  const shows=new Set(library.filter(m=>m.type==='show').map(m=>m.showName||m.title)).size;
  const inProgress=library.filter(m=>m.progress?.percent>0&&!m.watched).length;
  const unwatched=library.filter(m=>!m.watched).length;
  return `<div class="home-dashboard ${extraClass}" aria-label="Library snapshot">
    <button class="home-stat" onclick="openHeroStat('home')" aria-label="Show home library overview"><span>${library.length}</span><small>Total titles</small></button>
    <button class="home-stat" onclick="openHeroStat('movies')" aria-label="Open movies"><span>${movies}</span><small>Movies</small></button>
    <button class="home-stat" onclick="openHeroStat('shows')" aria-label="Open TV shows"><span>${shows}</span><small>Shows</small></button>
    <button class="home-stat accent" onclick="openHeroStat('continue')" aria-label="Open in-progress titles"><span>${inProgress}</span><small>In progress</small></button>
    <button class="home-stat cyan" onclick="openHeroStat('unwatched')" aria-label="Open unwatched movies"><span>${unwatched}</span><small>Unwatched</small></button>
  </div>`;
}

function renderHome(){
  if(library.length===0){
    const hf=folderConfig.length>0;
    return `<div class="empty-state"><div class="empty-icon">&#127916;</div><div class="empty-title">${hf?'No Media Found':"Welcome to Chochey's Media Server"}</div><div class="empty-text">${hf?'No video files found in your linked folders.':'Get started by linking your media folders.'}</div><div style="margin-top:18px"><button class="btn btn-primary" onclick="nav('settings',document.querySelector('[data-view=settings]'))">&#9881;&#65039; ${hf?'Manage':'Add'} Folders</button></div></div>`;
  }
  const cw=getContinueWatching();
  const rad=dismissedItems.recentlyAdded||{};
  // Recently Added: newest first, dedupe shows (keep latest episode per showName)
  // so a single binge doesn't dominate the row.
  const raSorted=[...library].sort((a,b)=>(b.addedAt||0)-(a.addedAt||0)).filter(m=>!rad[m.id]);
  const raSeen=new Set();
  const recentlyAdded=[];
  for(const item of raSorted){
    if(item.showName){
      const key=item.type+'::'+item.showName;
      if(raSeen.has(key))continue;
      raSeen.add(key);
    }
    recentlyAdded.push(item);
    if(recentlyAdded.length>=18)break;
  }
  const movies=library.filter(m=>m.type==='movie');
  const shows=library.filter(m=>m.type==='show');
  const nextEpisodes=getNextEpisodes();
  const smartPicks=getSmartPicks();
  const hero=cw.length>0?cw[0]:library[Math.floor(Math.random()*library.length)];
  let h=`<div class="home-shell">${renderHero(hero)}`;
  if(cw.length>0)h+=carouselWithDismiss('Continue Watching',cw,'continueWatching');
  if(nextEpisodes.length>0)h+=carousel('Next Episodes',nextEpisodes);
  if(recentlyAdded.length>0)h+=carouselWithDismiss('Recently Added',recentlyAdded,'recentlyAdded');
  if(smartPicks.length>0)h+=carousel('Smart Picks',smartPicks);
  if(movies.length>0)h+=carousel('Movies',movies.slice(0,18));
  if(shows.length>0)h+=carousel('TV Shows',shows.slice(0,18));
  for(const t of getCustomTypes()){
    const items=library.filter(m=>m.type===t);
    if(items.length>0)h+=carousel(customTypeLabel(t),items.slice(0,18));
  }
  return h+'</div>';
}

function renderHero(item){
  const posterSrc=item.omdbPosterUrl||item.posterUrl;
  const bg=posterSrc?`background-image:url('${escCssUrl(posterSrc)}')`:'';
  const rt=item.progress.percent>0?'Resume':'Play';
  const plot=item.plot?`<p class="hero-copy">${esc(item.plot)}</p>`:'';
  const progress=item.progress.percent>0?`<div class="hero-progress"><div class="hero-progress-fill" style="width:${item.progress.percent}%"></div></div>`:'';
  const deleteBtn=currentRole==='admin'?`<button class="btn-icon-ghost" data-title="${escAttr(item.title)}" onclick='event.stopPropagation();confirmDeleteMedia("${item.id}",this.dataset.title)' title="Delete from server" aria-label="Delete from server">&#128465;</button>`:'';
  const poster=posterSrc?`<img src="${escAttr(posterSrc)}" alt="${escAttr(item.title)} poster" loading="lazy">`:`<div class="card-placeholder">&#127916;</div>`;
  return `<div class="hero premium-hero"><div class="hero-bg" style="${bg}"></div><div class="hero-content"><span class="hero-tag">${mediaTypeLabel(item)}</span><h1 class="hero-title">${esc(item.title)}</h1><p class="hero-meta">${esc(mediaMetaLine(item))}</p>${plot}<div class="hero-actions"><button class="btn btn-primary" onclick='playMedia("${item.id}")'>&#9654; ${rt}</button><button class="btn btn-secondary" onclick='openMediaDetail("${item.id}")'>&#9432; Details</button><button class="btn btn-secondary" onclick='addToQueue("${item.id}")'>+ Queue</button>${deleteBtn}</div>${progress}</div><div class="hero-poster">${poster}</div>${renderHomeDashboard('hero-dashboard')}</div>`;
}

// ── Cards ──────────────────────────────────────────────────────────────
function card(item){
  const posterSrc=item.omdbPosterUrl||item.posterUrl;
  const poster=posterSrc?`<img src="${escAttr(posterSrc)}" alt="${escAttr(item.title)}" loading="lazy">`:`<div class="card-placeholder">&#127916;</div>`;
  const prog=item.progress.percent>0?`<div class="card-progress"><div class="card-progress-fill" style="width:${item.progress.percent}%"></div></div>`:'';
  const watched=item.watched?`<div class="card-watched-badge">&#10003;</div>`:'';
  const ratingBadge=item.imdbRating?`<div class="card-rating">IMDb ${esc(String(item.imdbRating))}</div>`:'';
  const genres=item.genre?`<div class="card-genres">${esc(item.genre)}</div>`:item.genres&&item.genres.length?`<div class="genre-tags">${item.genres.slice(0,3).map(g=>`<span class="genre-tag">${esc(g)}</span>`).join('')}</div>`:'';
  const typeLabel=mediaTypeLabel(item);
  const delBtn=currentRole==='admin'?`<button class="card-action-btn card-delete-btn" data-title="${escAttr(item.title)}" onclick="event.stopPropagation();confirmDeleteMedia('${item.id}',this.dataset.title)" title="Delete from server" aria-label="Delete ${escAttr(item.title)} from server">&#128465;</button>`:'';
  return `<div class="card media-card" data-id="${item.id}" onclick='openMediaDetail("${item.id}")' onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="View details for ${escAttr(item.title)}"><div class="card-poster">${poster}${prog}${watched}${ratingBadge}<div class="card-actions"><button class="card-action-btn" onclick="event.stopPropagation();toggleWatched('${item.id}',${!item.watched})" title="${item.watched?'Mark unwatched':'Mark watched'}" aria-label="${item.watched?'Mark as unwatched':'Mark as watched'}">&#128065;</button><button class="card-action-btn" onclick="event.stopPropagation();addToQueue('${item.id}')" title="Add to queue" aria-label="Add ${escAttr(item.title)} to queue">+Q</button>${delBtn}</div><div class="card-overlay"><button class="card-play-btn" onclick="event.stopPropagation();playMedia('${item.id}')" aria-label="Play ${escAttr(item.title)}"><span class="play-icon">&#9654;</span><span>Play</span></button></div></div><div class="card-info"><div class="card-title">${esc(item.title)}</div><div class="card-meta-line">${esc(mediaMetaLine(item))}</div><span class="card-type ${item.type}">${typeLabel}</span>${genres}</div></div>`;
}

function carousel(title,items){
  return `<div class="section"><div class="section-header"><h2 class="section-title">${title}</h2></div><div class="carousel-wrapper"><button class="carousel-btn left" onclick="this.parentElement.querySelector('.carousel').scrollBy({left:-400,behavior:'smooth'})">&#10094;</button><div class="carousel">${items.map(card).join('')}</div><button class="carousel-btn right" onclick="this.parentElement.querySelector('.carousel').scrollBy({left:400,behavior:'smooth'})">&#10095;</button></div></div>`;
}

// Card variant with dismiss (X) button for Continue Watching / Recently Added
function cardDismissable(item,section){
  const posterSrc=item.omdbPosterUrl||item.posterUrl;
  const poster=posterSrc?`<img src="${escAttr(posterSrc)}" alt="${escAttr(item.title)}" loading="lazy">`:`<div class="card-placeholder">&#127916;</div>`;
  const prog=item.progress.percent>0?`<div class="card-progress"><div class="card-progress-fill" style="width:${item.progress.percent}%"></div></div>`:'';
  const watched=item.watched?`<div class="card-watched-badge">&#10003;</div>`:'';
  const ratingBadge=item.imdbRating?`<div class="card-rating">IMDb ${esc(String(item.imdbRating))}</div>`:'';
  const genres=item.genre?`<div class="card-genres">${esc(item.genre)}</div>`:item.genres&&item.genres.length?`<div class="genre-tags">${item.genres.slice(0,3).map(g=>`<span class="genre-tag">${esc(g)}</span>`).join('')}</div>`:'';
  const typeLabel=mediaTypeLabel(item);
  const dismissBtn=`<button class="card-dismiss-btn" onclick="event.stopPropagation();dismissItem('${item.id}','${section}',this)" title="Hide from this list" aria-label="Hide ${escAttr(item.title)} from this list">&#10005;</button>`;
  const delBtn=currentRole==='admin'?`<button class="card-action-btn card-delete-btn" data-title="${escAttr(item.title)}" onclick="event.stopPropagation();confirmDeleteMedia('${item.id}',this.dataset.title)" title="Delete from server" aria-label="Delete ${escAttr(item.title)} from server">&#128465;</button>`:'';
  return `<div class="card media-card" data-id="${item.id}" onclick='openMediaDetail("${item.id}")' onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="View details for ${escAttr(item.title)}"><div class="card-poster">${poster}${prog}${watched}${ratingBadge}${dismissBtn}<div class="card-actions"><button class="card-action-btn" onclick="event.stopPropagation();toggleWatched('${item.id}',${!item.watched})" title="${item.watched?'Mark unwatched':'Mark watched'}" aria-label="${item.watched?'Mark as unwatched':'Mark as watched'}">&#128065;</button><button class="card-action-btn" onclick="event.stopPropagation();addToQueue('${item.id}')" title="Add to queue" aria-label="Add ${escAttr(item.title)} to queue">+Q</button>${delBtn}</div><div class="card-overlay"><button class="card-play-btn" onclick="event.stopPropagation();playMedia('${item.id}')" aria-label="Play ${escAttr(item.title)}"><span class="play-icon">&#9654;</span><span>Play</span></button></div></div><div class="card-info"><div class="card-title">${esc(item.title)}</div><div class="card-meta-line">${esc(mediaMetaLine(item))}</div><span class="card-type ${item.type}">${typeLabel}</span>${genres}</div></div>`;
}

function carouselWithDismiss(title,items,section){
  return `<div class="section"><div class="section-header"><h2 class="section-title">${title}</h2></div><div class="carousel-wrapper"><button class="carousel-btn left" onclick="this.parentElement.querySelector('.carousel').scrollBy({left:-400,behavior:'smooth'})">&#10094;</button><div class="carousel">${items.map(i=>cardDismissable(i,section)).join('')}</div><button class="carousel-btn right" onclick="this.parentElement.querySelector('.carousel').scrollBy({left:400,behavior:'smooth'})">&#10095;</button></div></div>`;
}

function openMediaDetail(id){
  const item=library.find(m=>m.id===id);
  if(!item)return;
  closeMediaDetail();
  const posterSrc=item.omdbPosterUrl||item.posterUrl;
  const bg=posterSrc?`style="background-image:url('${escCssUrl(posterSrc)}')"`:'';
  const poster=posterSrc?`<img src="${escAttr(posterSrc)}" alt="${escAttr(item.title)} poster">`:`<div class="card-placeholder">&#127916;</div>`;
  const plot=item.plot||'No synopsis yet. Press play and let the media do the convincing.';
  const progress=item.progress?.percent>0?`<div class="detail-progress"><div class="detail-progress-fill" style="width:${item.progress.percent}%"></div></div><div class="detail-progress-label">${item.progress.percent}% watched</div>`:'';
  const showBtn=item.showName?`<button class="btn btn-secondary" onclick='openShowFromEpisode("${item.id}")'>All Episodes</button>`:'';
  const deleteBtn=currentRole==='admin'?`<button class="btn btn-danger-outline" data-title="${escAttr(item.title)}" onclick='confirmDeleteMedia("${item.id}",this.dataset.title);closeMediaDetail();'>Delete</button>`:'';
  const overlay=document.createElement('div');
  overlay.className='media-detail-overlay visible';
  overlay.id='mediaDetailOverlay';
  overlay.innerHTML=`<div class="media-detail-backdrop" ${bg}></div><aside class="media-detail-drawer" role="dialog" aria-modal="true" aria-label="${escAttr(item.title)} details">
    <button class="detail-close" onclick="closeMediaDetail()" aria-label="Close details">&#10005;</button>
    <div class="detail-poster">${poster}</div>
    <div class="detail-body">
      <span class="hero-tag">${mediaTypeLabel(item)}</span>
      <h2>${esc(item.title)}</h2>
      <p class="detail-meta">${esc(mediaMetaLine(item))}</p>
      ${progress}
      <p class="detail-copy">${esc(plot)}</p>
      <div class="detail-actions">
        <button class="btn btn-primary" onclick='playMedia("${item.id}");closeMediaDetail();'>&#9654; ${item.progress?.percent>0?'Resume':'Play'}</button>
        <button class="btn btn-secondary" onclick='addToQueue("${item.id}")'>+ Queue</button>
        ${showBtn}
        <button class="btn btn-secondary" onclick='toggleWatched("${item.id}",${!item.watched});closeMediaDetail();'>${item.watched?'Mark Unwatched':'Mark Watched'}</button>
        ${deleteBtn}
      </div>
    </div>
  </aside>`;
  overlay.addEventListener('click',e=>{if(e.target===overlay)closeMediaDetail();});
  document.body.appendChild(overlay);
  document.body.classList.add('detail-open');
}

function openShowFromEpisode(id){
  const item=library.find(m=>m.id===id);
  if(!item?.showName)return;
  closeMediaDetail();
  openShow(item.showName,item.type||'show');
}

function closeMediaDetail(){
  const overlay=document.getElementById('mediaDetailOverlay');
  if(!overlay)return;
  overlay.classList.remove('visible');
  document.body.classList.remove('detail-open');
  setTimeout(()=>overlay.remove(),180);
}

// ── Delete media from server (admin only) ─────────────────────────────
function confirmDeleteMedia(id,title){
  const overlay=document.createElement('div');
  overlay.className='delete-confirm-overlay';
  overlay.innerHTML=`<div class="delete-confirm-dialog"><h3>Delete from server?</h3><p>This will permanently delete <strong id="deleteTitle"></strong> from disk and remove all associated data.</p><p style="color:var(--danger);font-size:.85rem">This cannot be undone.</p><div class="delete-confirm-actions"><button class="btn btn-secondary" id="deleteCancel">Cancel</button><button class="btn btn-danger" id="deleteConfirm">Delete</button></div></div>`;
  overlay.querySelector('#deleteTitle').textContent=title;
  document.body.appendChild(overlay);
  requestAnimationFrame(()=>overlay.classList.add('visible'));
  document.getElementById('deleteCancel').onclick=()=>{overlay.classList.remove('visible');setTimeout(()=>overlay.remove(),200);};
  overlay.addEventListener('click',e=>{if(e.target===overlay){overlay.classList.remove('visible');setTimeout(()=>overlay.remove(),200);}});
  document.getElementById('deleteConfirm').onclick=()=>deleteMedia(id,title,overlay);
}

async function deleteMedia(id,title,overlay){
  const btn=document.getElementById('deleteConfirm');
  btn.disabled=true;btn.textContent='Deleting...';
  try{
    const res=await fetch('/api/media/'+id,{method:'DELETE'});
    const data=await res.json();
    if(!res.ok)throw new Error(data.error||'Delete failed');
    overlay.classList.remove('visible');setTimeout(()=>overlay.remove(),200);
    // Remove card from DOM with animation
    document.querySelectorAll(`.card[data-id="${id}"]`).forEach(c=>{
      c.style.transition='opacity .3s,transform .3s';c.style.opacity='0';c.style.transform='scale(.9)';
      setTimeout(()=>c.remove(),300);
    });
    // If currently playing this item, close player and go home
    if(currentMedia&&currentMedia.id===id){currentMedia=null;closePlayer();nav('home',document.querySelector('[data-view="home"]'));}
    // If on show detail page, re-render to update episode list
    else if(currentView==='showDetail'){renderView();}
  }catch(e){
    btn.disabled=false;btn.textContent='Delete';
    showToast('Failed to delete: '+e.message,'error');
  }
}

async function dismissItem(id,section,btn){
  const endpoint=section==='continueWatching'?'continue-watching':'recently-added';
  try{
    await fetch(`/api/dismissed/${endpoint}/${id}?profile=${activeProfile}`,{method:'POST'});
    if(section==='continueWatching'){dismissedItems.continueWatching[id]=true;}
    else{dismissedItems.recentlyAdded[id]=true;}
    // Remove card from DOM immediately — no full re-render needed
    const cardEl=btn.closest('.card');
    if(cardEl){
      cardEl.style.transition='opacity .25s,transform .25s';
      cardEl.style.opacity='0';
      cardEl.style.transform='scale(.9)';
      setTimeout(()=>cardEl.remove(),260);
    }
  }catch(e){console.error('dismiss failed',e);}
}

// ── Paginated grid with infinite scroll ───────────────────────────────
const paginationState={};
let activeGridObserver=null;

function renderPaginatedGrid(type,label){
  if(activeGridObserver){activeGridObserver.disconnect();activeGridObserver=null;}
  const stateKey=type+'_'+watchFilter+'_'+document.getElementById('sortSelect').value;
  paginationState[stateKey]={page:0,total:0,loading:false,done:false,type,label};
  return `<div class="section" id="pgrid-section-${type}"><div class="section-header"><h2 class="section-title" id="pgrid-title-${type}">${label}</h2></div><div class="grid" id="pgrid-${type}"></div><div id="pgrid-sentinel-${type}" style="height:1px"></div><div id="pgrid-loading-${type}" style="text-align:center;padding:20px;display:none;color:var(--text-muted)">Loading...</div></div>`;
}

async function loadNextPage(type){
  const sort=document.getElementById('sortSelect').value;
  const stateKey=type+'_'+watchFilter+'_'+sort;
  const state=paginationState[stateKey];
  if(!state||state.loading||state.done)return;
  state.loading=true;
  const loader=document.getElementById('pgrid-loading-'+type);
  if(loader)loader.style.display='';
  const page=state.page+1;
  const params=new URLSearchParams({profile:activeProfile,type,page:String(page),limit:'60',sort});
  if(watchFilter!=='all')params.set('filter',watchFilter);
  try{
    const res=await fetch('/api/library?'+params.toString());
    const data=await res.json();
    const grid=document.getElementById('pgrid-'+type);
    const title=document.getElementById('pgrid-title-'+type);
    if(!grid||!data.items)return;
    if(data.total===0&&state.page===0){
      grid.closest('.section').innerHTML=`<div class="empty-state"><div class="empty-icon">&#127916;</div><div class="empty-title">No ${state.label} Found</div><div class="empty-text">Link a folder or adjust your filters.</div></div>`;
      state.done=true;
      return;
    }
    grid.insertAdjacentHTML('beforeend',data.items.map(card).join(''));
    state.page=data.page;
    state.total=data.total;
    state.done=data.page>=data.totalPages;
    if(title)title.textContent=state.label+' ('+data.total+')';
  }catch(e){console.error('loadNextPage error',e);}
  state.loading=false;
  if(loader)loader.style.display='none';
}

function setupGridObserver(type){
  const sentinel=document.getElementById('pgrid-sentinel-'+type);
  if(!sentinel)return;
  if(activeGridObserver)activeGridObserver.disconnect();
  activeGridObserver=new IntersectionObserver(entries=>{
    if(entries[0].isIntersecting)loadNextPage(type);
  },{rootMargin:'400px'});
  activeGridObserver.observe(sentinel);
  loadNextPage(type);
}

function renderGrid(type,label){
  const items=getFiltered(library.filter(m=>m.type===type));
  if(items.length===0)return `<div class="empty-state"><div class="empty-icon">${type==='movie'?'&#127916;':'&#128250;'}</div><div class="empty-title">No ${label} Found</div><div class="empty-text">Link a folder or adjust your filters.</div></div>`;
  return `<div class="section"><div class="section-header"><h2 class="section-title">${label} (${items.length})</h2></div><div class="grid">${items.map(card).join('')}</div></div>`;
}

function firstEpisode(items){
  return [...items].sort((a,b)=>{
    const seasonSort=(a.epInfo?.season||0)-(b.epInfo?.season||0);
    if(seasonSort)return seasonSort;
    const episodeSort=(a.epInfo?.episode||0)-(b.epInfo?.episode||0);
    if(episodeSort)return episodeSort;
    return (a.filename||a.title).localeCompare(b.filename||b.title,undefined,{numeric:true});
  })[0];
}

// Deduplicate Continue Watching: for shows, only show the most recently watched episode per show
function getContinueWatching(){
  const cwd=dismissedItems.continueWatching||{};
  const inProgress=library.filter(m=>m.progress.percent>0&&m.progress.percent<95&&!cwd[m.id]);
  // Sort by most recently updated first
  inProgress.sort((a,b)=>(b.progress.updatedAt||0)-(a.progress.updatedAt||0));
  // Deduplicate shows: keep only the most recent episode per showName
  const seen=new Set();
  const result=[];
  for(const item of inProgress){
    if(item.showName){
      const key=item.type+'::'+item.showName;
      if(seen.has(key))continue;
      seen.add(key);
    }
    result.push(item);
  }
  return result;
}

function renderContinue(){
  const items=getContinueWatching();
  if(!items.length)return '<div class="empty-state"><div class="empty-icon">&#9654;&#65039;</div><div class="empty-title">Nothing in Progress</div><div class="empty-text">Start watching something and it will appear here.</div></div>';
  return `<div class="section"><div class="section-header"><h2 class="section-title">Continue Watching</h2></div><div class="grid">${items.map(i=>cardDismissable(i,'continueWatching')).join('')}</div></div>`;
}

// ── Shows grouped view ─────────────────────────────────────────────────
let currentShowName=null;
let currentShowType='show'; // track which type opened the show detail

function renderShowsView(){
  const showItems=library.filter(m=>m.type==='show');
  // Group by showName
  const shows={};
  for(const item of showItems){
    const name=item.showName||item.title;
    if(!shows[name])shows[name]={name,items:[],poster:null,year:null,imdbRating:null,watched:true};
    shows[name].items.push(item);
    if(!shows[name].poster)shows[name].poster=item.omdbPosterUrl||item.posterUrl||null;
    if(!shows[name].year&&item.year)shows[name].year=item.year;
    if(!shows[name].imdbRating&&item.imdbRating)shows[name].imdbRating=item.imdbRating;
    if(!item.watched)shows[name].watched=false;
  }
  let showList=Object.values(shows);

  // Apply watch filter
  if(watchFilter==='watched')showList=showList.filter(s=>s.watched);
  if(watchFilter==='unwatched')showList=showList.filter(s=>!s.watched);

  // Apply sort
  const s=document.getElementById('sortSelect').value;
  switch(s){
    case 'title-asc':showList.sort((a,b)=>a.name.localeCompare(b.name));break;
    case 'title-desc':showList.sort((a,b)=>b.name.localeCompare(a.name));break;
    case 'year-desc':showList.sort((a,b)=>(b.year||0)-(a.year||0));break;
    case 'year-asc':showList.sort((a,b)=>(a.year||9999)-(b.year||9999));break;
    case 'rating-desc':showList.sort((a,b)=>(parseFloat(b.imdbRating)||0)-(parseFloat(a.imdbRating)||0));break;
    default:showList.sort((a,b)=>a.name.localeCompare(b.name));
  }

  if(!showList.length)return '<div class="empty-state"><div class="empty-icon">&#128250;</div><div class="empty-title">No TV Shows Found</div><div class="empty-text">Link a folder for TV Shows in settings.</div></div>';

  // Show as cards that open detail pages
  const cards=showList.map(s=>{
    const ep=s.items.length;
    const first=firstEpisode(s.items);
    const poster=s.poster?`<img src="${s.poster}" alt="${esc(s.name)} poster" loading="lazy">`:`<div class="card-placeholder">&#128250;</div>`;
    return `<div class="card media-card" onclick="openShow('${escAttr(s.name)}','show')" onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="Open ${escAttr(s.name)}"><div class="card-poster">${poster}<div class="card-overlay"><button class="card-play-btn" onclick="event.stopPropagation();playMedia('${first.id}')" aria-label="Play ${escAttr(s.name)}"><span class="play-icon">&#9654;</span><span>Play</span></button></div></div><div class="card-info"><div class="card-title">${esc(s.name)}</div><div class="card-year">${ep} episode${ep>1?'s':''}</div><span class="card-type show">TV Show</span></div></div>`;
  });

  return `<div class="section"><div class="section-header"><h2 class="section-title">TV Shows (${showList.length})</h2></div><div class="grid">${cards.join('')}</div></div>`;
}

function openShow(name,type){
  currentShowName=name;
  currentShowType=type||'show';
  currentView='showDetail';
  updateLayoutChrome('showDetail');
  renderView();
}

function renderShowDetail(showName){
  const items=library.filter(m=>m.type===currentShowType&&(m.showName||m.title)===showName);
  if(!items.length)return '<div class="empty-state"><div class="empty-title">Show not found</div></div>';

  items.sort((a,b)=>{
    if(a.epInfo&&b.epInfo){
      if(a.epInfo.season!==b.epInfo.season)return a.epInfo.season-b.epInfo.season;
      return a.epInfo.episode-b.epInfo.episode;
    }
    return a.filename.localeCompare(b.filename,undefined,{numeric:true});
  });

  // Group by season
  const seasons={};
  for(const item of items){
    const s=item.epInfo?item.epInfo.season:0;
    if(!seasons[s])seasons[s]=[];
    seasons[s].push(item);
  }

  const poster=items.find(i=>i.posterUrl);
  const totalEps=items.length;
  const watchedEps=items.filter(i=>i.watched).length;

  let seasonsHtml=Object.entries(seasons).sort(([a],[b])=>a-b).map(([sNum,eps])=>{
    const epRows=eps.map(ep=>{
      const epNum=ep.epInfo?`E${String(ep.epInfo.episode).padStart(2,'0')}`:'';
      const prog=ep.progress.percent||0;
      const epDel=currentRole==='admin'?`<button class="episode-delete-btn" onclick="event.stopPropagation();confirmDeleteMedia('${ep.id}','${esc(ep.title)}')" title="Delete episode" aria-label="Delete ${escAttr(ep.title)}">&#128465;</button>`:'';
      return `<div class="episode-row" onclick='openMediaDetail("${ep.id}")' onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="View details for ${escAttr(ep.title)}"><div class="episode-num">${epNum}</div><div class="episode-info"><div class="episode-title">${esc(ep.title)}</div><div class="episode-file">${esc(ep.filename)}</div></div><button class="episode-play-btn" onclick="event.stopPropagation();playMedia('${ep.id}')" aria-label="Play ${escAttr(ep.title)}"><span class="play-icon">&#9654;</span><span>Play</span></button><div class="episode-progress"><div class="episode-progress-fill" style="width:${prog}%"></div></div>${ep.watched?'<div class="episode-watched">✓</div>':''}${epDel}</div>`;
    }).join('');
    return `<div class="season-section"><div class="season-title">${sNum==='0'?'Episodes':`Season ${sNum}`} (${eps.length} episodes)</div><div class="episode-list">${epRows}</div></div>`;
  }).join('');

  const backView=currentShowType==='show'?'shows':'custom_'+currentShowType;
  const backLabel=currentShowType==='show'?'Shows':customTypeLabel(currentShowType);
  return `<div class="show-detail"><button class="btn btn-ghost" onclick="nav('${backView}',document.querySelector('[data-view=&quot;${backView}&quot;]'))" style="margin-bottom:16px">← Back to ${backLabel}</button><div class="show-detail-header">${poster?`<div class="show-detail-poster"><img src="${poster.posterUrl}"></div>`:''}<div class="show-detail-info"><h1>${esc(showName)}</h1><div class="show-detail-meta">${totalEps} episodes · ${watchedEps} watched</div><div class="show-detail-actions"><button class="btn btn-primary btn-sm" onclick='playMedia("${items[0].id}")'>&#9654; Play First</button><button class="btn btn-secondary btn-sm" onclick="markAllWatched('${escAttr(showName)}',true)">Mark All Watched</button><button class="btn btn-ghost" onclick="markAllWatched('${escAttr(showName)}',false)">Reset</button></div></div></div>${seasonsHtml}</div>`;
}

async function markAllWatched(showName,watched){
  const items=library.filter(m=>(m.showName||m.title)===showName&&(m.type==='show'||m.type===currentShowType));
  // Send requests in parallel batches of 10 for speed
  const BATCH=10;
  for(let i=0;i<items.length;i+=BATCH){
    await Promise.all(items.slice(i,i+BATCH).map(item=>
      fetch('/api/watched',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:item.id,watched,profile:activeProfile})})
    ));
  }
  await fetchLib();
}

// ── Queue ──────────────────────────────────────────────────────────────
function renderQueue(){
  if(!profileQueue.length)return '<div class="empty-state"><div class="empty-icon">&#128203;</div><div class="empty-title">Queue is Empty</div><div class="empty-text">Add titles from the library to build your watch list.</div></div>';
  const items=profileQueue.map((id,i)=>{
    const item=library.find(m=>m.id===id);
    if(!item)return '';
    return `<div class="queue-item" onclick='playMedia("${id}")' onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="Play ${escAttr(item.title)}"><div class="queue-num">${i+1}</div><div class="queue-title">${esc(item.title)}</div><div class="queue-type">${item.type}</div><button class="btn-ghost" onclick="event.stopPropagation();removeFromQueue('${id}')" style="color:var(--danger)" aria-label="Remove ${escAttr(item.title)} from queue">&#10005;</button></div>`;
  }).join('');
  return `<div class="section"><div class="section-header"><h2 class="section-title">Up Next (${profileQueue.length})</h2><button class="btn btn-ghost" onclick="clearQueue()">Clear All</button></div>${items}</div>`;
}

async function addToQueue(id){
  await fetch('/api/queue/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,profile:activeProfile})});
  await fetchQueue();
  if(currentView==='queue')renderView();
}

async function removeFromQueue(id){
  await fetch('/api/queue/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,profile:activeProfile})});
  await fetchQueue();
  if(currentView==='queue')renderView();
}

async function clearQueue(){
  await fetch('/api/queue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({queue:[],profile:activeProfile})});
  await fetchQueue();renderView();
}

// ── History ────────────────────────────────────────────────────────────
async function renderHistory(){
  const res=await fetch(`/api/history?profile=${activeProfile}`);
  const history=await res.json();
  const a=document.getElementById('contentArea');
  if(!history.length){a.innerHTML='<div class="empty-state"><div class="empty-icon">&#128337;</div><div class="empty-title">No Watch History</div></div>';return;}
  const items=history.map(h=>{
    const time=new Date(h.timestamp).toLocaleDateString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    return `<div class="history-item" onclick='playMedia("${h.id}")' onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="Play ${escAttr(h.title||'Unknown')}"><div class="history-time">${time}</div><div class="history-title">${esc(h.title||'Unknown')}</div></div>`;
  }).join('');
  a.innerHTML=`<div class="section"><div class="section-header"><h2 class="section-title">Watch History</h2></div>${items}</div>`;
}

// ── Watched toggle ─────────────────────────────────────────────────────
async function toggleWatched(id,watched){
  await fetch('/api/watched',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,watched,profile:activeProfile})});
  await fetchLib();
}

// ── Random / Shuffle ───────────────────────────────────────────────────
function playRandom(){
  const pool=library.filter(m=>!m.watched);
  if(!pool.length){showToast('Everything is watched!','info');return;}
  const pick=pool[Math.floor(Math.random()*pool.length)];
  playMedia(pick.id);
}

// ── Search ─────────────────────────────────────────────────────────────
let _searchDebounce=null;
function handleSearch(){
  clearTimeout(_searchDebounce);
  _searchDebounce=setTimeout(()=>_doSearch(),250);
}
async function _doSearch(){
  const q=document.getElementById('searchInput').value.trim();
  if(!q){renderView();return;}
  // Use server-side search so results include all items (not just loaded pages)
  const params=new URLSearchParams({profile:activeProfile,search:q});
  if(currentView==='movies')params.set('type','movie');
  else if(currentView==='shows')params.set('type','show');
  else if(currentView.startsWith('custom_'))params.set('type',currentView.slice(7));
  let r;
  try{
    const res=await fetch('/api/library?'+params.toString());
    r=await res.json();
    // Handle both paginated {items} and flat array responses
    if(!Array.isArray(r))r=r.items||[];
  }catch(e){console.error('Search error:',e);r=[];}
  const a=document.getElementById('contentArea');
  if(!r.length){a.innerHTML='<div class="empty-state"><div class="empty-icon">&#128269;</div><div class="empty-title">No Results</div></div>';return;}
  // Group items with showName into single cards (TV shows + custom series)
  const standalone=r.filter(m=>!m.showName);
  const showMap={};
  for(const item of r.filter(m=>m.showName)){
    const key=item.type+'::'+item.showName;
    const name=item.showName;
    if(!showMap[key])showMap[key]={name,type:item.type,items:[],poster:null,imdbRating:null,genre:null,year:null};
    showMap[key].items.push(item);
    if(!showMap[key].poster)showMap[key].poster=item.omdbPosterUrl||item.posterUrl||null;
    if(!showMap[key].imdbRating&&item.imdbRating)showMap[key].imdbRating=item.imdbRating;
    if(!showMap[key].genre&&item.genre)showMap[key].genre=item.genre;
    if(!showMap[key].year&&item.year)showMap[key].year=item.year;
  }
  const showCards=Object.values(showMap).map(s=>{
    const ep=s.items.length;
    const seasons=new Set(s.items.map(i=>i.epInfo?i.epInfo.season:0).filter(n=>n>0));
    const meta=seasons.size?`${seasons.size} season${seasons.size>1?'s':''}, ${ep} ep${ep>1?'s':''}`:`${ep} episode${ep>1?'s':''}`;
    const poster=s.poster?`<img src="${s.poster}" alt="${esc(s.name)} poster" loading="lazy">`:`<div class="card-placeholder">&#128250;</div>`;
    const ratingBadge=s.imdbRating?`<div class="card-rating">★ ${s.imdbRating}</div>`:'';
    const genres=s.genre?`<div class="card-genres">${s.genre}</div>`:'';
    const tLabel=s.type==='show'?'TV Show':customTypeLabel(s.type);
    return `<div class="card" onclick="openShow('${escAttr(s.name)}','${escAttr(s.type)}')" onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="Open ${escAttr(s.name)}"><div class="card-poster">${poster}${ratingBadge}<div class="card-overlay"><div class="play-icon">&#9654;</div></div></div><div class="card-info"><div class="card-title">${esc(s.name)}</div><div class="card-year">${meta}</div>${s.year?`<div class="card-year">${s.year}</div>`:''}<span class="card-type ${s.type}">${tLabel}</span>${genres}</div></div>`;
  });
  const allCards=standalone.map(card).concat(showCards);
  const total=standalone.length+Object.keys(showMap).length;
  a.innerHTML=`<div class="section"><div class="section-header"><h2 class="section-title">${total} result${total>1?'s':''}</h2></div><div class="grid">${allCards.join('')}</div></div>`;
}

// ══════════════════════════════════════════════════════════════════════
// Settings
// ══════════════════════════════════════════════════════════════════════
let spriteProgress=null;
async function fetchSpriteProgress(){try{spriteProgress=await(await fetch('/api/sprites/progress')).json();}catch{spriteProgress=null;}}
let corruptedData=null;
async function fetchCorrupted(){try{corruptedData=await(await adminFetch('/api/corrupted')).json();}catch{corruptedData=null;}}
let nowWatchingData=null;
async function fetchNowWatching(){try{nowWatchingData=await(await adminFetch('/api/now-watching')).json();}catch{nowWatchingData=null;}}
function fmtProgress(cur,dur){if(!dur)return '';const pct=Math.round(cur/dur*100);const m=Math.floor(cur/60),s=Math.floor(cur%60);return `${m}:${String(s).padStart(2,'0')} / ${Math.floor(dur/60)}:${String(Math.floor(dur%60)).padStart(2,'0')} (${pct}%)`;}
function renderTranscodeSection(){
  const viewers=nowWatchingData||[];
  const count=viewers.length;
  const badge=count>0?`<span class="transcode-badge active">${count} watching</span>`:`<span class="transcode-badge idle">Nobody</span>`;
  let list='';
  if(count>0){
    const items=viewers.map(w=>`<div class="transcode-item"><div class="transcode-item-body"><div class="transcode-item-file">${esc(w.title)}</div><div class="transcode-item-meta">${esc(w.profileName)}${w.duration?' · '+fmtProgress(w.currentTime,w.duration):''}</div></div></div>`).join('');
    list=`<div class="transcode-list">${items}</div>`;
  }
  return `<div class="transcode-section"><div class="transcode-section-title"><span>Now Watching</span>${badge}</div>${count===0?'<div style="font-size:.8rem;color:var(--text-muted)">Nobody is watching anything right now.</div>':list}</div>`;
}
function updateTranscodeSection(){
  const el=document.getElementById('transcodeSection');
  if(!el)return;
  el.outerHTML=`<div id="transcodeSection">${renderTranscodeSection()}</div>`;
}
function fmtDate(ms){const d=new Date(ms);return d.toLocaleDateString()+(': ')+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});}
function renderCorruptedSection(){
  if(!corruptedData)return '';
  const count=corruptedData.length;
  const badge=count>0?`<span class="corrupted-badge has-items">${count} corrupted</span>`:`<span class="corrupted-badge none">None detected</span>`;
  let list='';
  if(count>0){
    const items=corruptedData.map(f=>`<div class="corrupted-item"><div class="corrupted-item-body"><div class="corrupted-item-title" title="${escAttr(f.filePath)}">${esc(f.title||f.filePath)}</div><div class="corrupted-item-reason">${esc(f.reason||'unknown reason')}</div><div class="corrupted-item-date">Detected: ${fmtDate(f.detectedAt)}</div></div><div class="corrupted-item-actions"><button class="btn btn-secondary btn-sm" onclick="retryCorrupted('${escAttr(f.id)}',this)">Retry</button><button class="btn btn-danger btn-sm" onclick="removeCorrupted('${escAttr(f.id)}')">Remove</button></div></div>`).join('');
    const retryBtn=`<button class="btn btn-secondary btn-sm" style="font-size:.75rem;padding:4px 12px" onclick="retryAllCorrupted(this)">Retry All</button>`;
    const clearBtn=`<button class="btn btn-danger btn-sm" style="font-size:.75rem;padding:4px 12px" onclick="clearAllCorrupted()">Clear All</button>`;
    list=`<div class="corrupted-list">${items}</div><div style="margin-top:10px;display:flex;justify-content:flex-end;gap:8px">${retryBtn}${clearBtn}</div>`;
  }
  return `<h3 style="font-size:1rem;font-weight:700;margin:20px 0 12px">Corrupted Files</h3><div class="corrupted-section"><div class="corrupted-section-title"><span>Files that failed during sprite generation</span>${badge}</div>${list}</div>`;
}
function updateCorruptedSection(){
  const el=document.getElementById('corruptedSection');
  if(!el||!corruptedData)return;
  el.outerHTML=`<div id="corruptedSection">${renderCorruptedSection()}</div>`;
}
async function removeCorrupted(id){
  try{const r=await adminFetch('/api/corrupted/'+id,{method:'DELETE'});if(!r.ok)return;await fetchCorrupted();updateCorruptedSection();}catch{}
}
async function retryCorrupted(id,btn){
  if(btn){btn.disabled=true;btn.textContent='Retrying...';}
  try{
    const r=await adminFetch('/api/corrupted/'+id+'/retry',{method:'POST'});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||'Retry failed');
    showToast(data.started?'Sprite retry queued.':'Retry will run after the current sprite queue finishes.','success');
    await Promise.all([fetchCorrupted(),fetchSpriteProgress()]);
    updateCorruptedSection();
    updateSpriteSection();
  }catch(e){
    showToast(e.message||'Retry failed','error');
    if(btn){btn.disabled=false;btn.textContent='Retry';}
  }
}
async function retryAllCorrupted(btn){
  if(!corruptedData||corruptedData.length===0)return;
  if(btn){btn.disabled=true;btn.textContent='Retrying...';}
  try{
    const r=await adminFetch('/api/corrupted/retry-all',{method:'POST'});
    const data=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(data.error||'Retry failed');
    showToast(`${data.retried||0} sprite ${data.retried===1?'retry':'retries'} queued.`,'success');
    await Promise.all([fetchCorrupted(),fetchSpriteProgress()]);
    updateCorruptedSection();
    updateSpriteSection();
  }catch(e){
    showToast(e.message||'Retry failed','error');
    if(btn){btn.disabled=false;btn.textContent='Retry All';}
  }
}
async function clearAllCorrupted(){
  if(!corruptedData||corruptedData.length===0)return;
  if(!confirm(`Remove all ${corruptedData.length} corrupted file entries? (This won't delete the actual files.)`))return;
  try{await Promise.all(corruptedData.map(f=>adminFetch('/api/corrupted/'+f.id,{method:'DELETE'})));await fetchCorrupted();updateCorruptedSection();}catch{}
}
let sysStats=null;
async function fetchSysStats(){try{sysStats=await(await fetch('/api/system/stats')).json();}catch{sysStats=null;}}
function fmtBytes(b){if(b>=1e12)return (b/1e12).toFixed(1)+'TB';if(b>=1e9)return (b/1e9).toFixed(1)+'GB';if(b>=1e6)return (b/1e6).toFixed(0)+'MB';return (b/1e3).toFixed(0)+'KB';}
function fmtUptime(s){const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60);return (d?d+'d ':'')+(h?h+'h ':'')+(m?m+'m':'');}
function barClass(p){return p>=90?'crit':p>=70?'warn':'ok';}
function renderSysStats(){
  if(!sysStats)return '';
  const s=sysStats;
  let html='<h3 style="font-size:1rem;font-weight:700;margin:20px 0 12px">System</h3><div class="sys-stats" id="sysStatsGrid">';
  // CPU
  html+=`<div class="sys-card"><div class="sys-card-title">CPU</div><div class="sys-card-value">${s.cpu.percent}%</div><div class="sys-bar"><div class="sys-bar-fill ${barClass(s.cpu.percent)}" style="width:${s.cpu.percent}%"></div></div><div class="sys-card-sub">${esc(s.cpu.model.replace(/\(R\)|\(TM\)/g,''))}<br>${s.cpu.cores} cores · Load: ${s.cpu.loadAvg[0].toFixed(1)}</div></div>`;
  // Memory
  html+=`<div class="sys-card"><div class="sys-card-title">Memory</div><div class="sys-card-value">${fmtBytes(s.memory.used)} / ${fmtBytes(s.memory.total)}</div><div class="sys-bar"><div class="sys-bar-fill ${barClass(s.memory.percent)}" style="width:${s.memory.percent}%"></div></div><div class="sys-card-sub">${s.memory.percent}% used · ${fmtBytes(s.memory.free)} free</div></div>`;
  // GPU
  if(s.gpu){
    const gpuPct=s.gpu.freqMhz&&s.gpu.maxFreqMhz?Math.round((s.gpu.freqMhz/s.gpu.maxFreqMhz)*100):0;
    html+=`<div class="sys-card"><div class="sys-card-title">GPU</div><div class="sys-card-value">${s.gpu.freqMhz||'--'} MHz</div><div class="sys-bar"><div class="sys-bar-fill ${barClass(gpuPct)}" style="width:${gpuPct}%"></div></div><div class="sys-card-sub">${esc(s.gpu.name.replace(/.*\]\s*/,''))}<br>Max: ${s.gpu.maxFreqMhz} MHz</div></div>`;
  }
  // Uptime + Transcodes
  html+=`<div class="sys-card"><div class="sys-card-title">Server</div><div class="sys-card-value">${fmtUptime(s.uptime)}</div><div class="sys-card-sub">Uptime<br>Active transcodes: ${s.activeTranscodes}</div></div>`;
  // Disks
  for(const d of s.disks){
    html+=`<div class="sys-card"><div class="sys-card-title">${esc(d.mount)}</div><div class="sys-card-value">${fmtBytes(d.used)} / ${fmtBytes(d.total)}</div><div class="sys-bar"><div class="sys-bar-fill ${barClass(d.percent)}" style="width:${d.percent}%"></div></div><div class="sys-card-sub">${d.percent}% used · ${fmtBytes(d.available)} free</div></div>`;
  }
  html+='</div>';
  return html;
}

let dashboardData={downloads:null,docker:null,errors:null,scans:null};
async function fetchDashboardData(){
  const tasks=[fetchStats(),fetchSpriteProgress(),fetchSysStats()];
  if(currentRole==='admin')tasks.push(fetchConfig(),fetchCorrupted());
  if(currentRole==='admin'||hasPerm('canLogs'))tasks.push(fetchNowWatching(),fetchDashboardLogs());
  if(currentRole==='admin'||hasPerm('canDownload'))tasks.push(fetchDashboardDownloads());
  if(currentRole==='admin')tasks.push(fetchDashboardDocker());
  await Promise.allSettled(tasks);
}

async function fetchDashboardDownloads(){
  dashboardData.downloads={connected:false,torrents:[],error:null};
  try{
    const status=await(await fetch('/api/qbt/status',{credentials:'same-origin'})).json();
    dashboardData.downloads.connected=!!status.connected;
    dashboardData.downloads.error=status.error||null;
    if(status.connected){
      const torrents=await(await fetch('/api/qbt/torrents',{credentials:'same-origin'})).json();
      dashboardData.downloads.torrents=Array.isArray(torrents)?torrents:[];
    }
  }catch(e){dashboardData.downloads={connected:false,torrents:[],error:'Could not reach qBittorrent'};}
}

async function fetchDashboardDocker(){
  dashboardData.docker=null;
  try{const r=await adminFetch('/api/docker/status');if(r.ok)dashboardData.docker=await r.json();}catch{}
}

async function fetchDashboardLogs(){
  dashboardData.errors=[];
  dashboardData.scans=[];
  try{const r=await fetch('/api/admin/error-logs',{credentials:'same-origin'});if(r.ok)dashboardData.errors=(await r.json()).slice(0,4);}catch{}
  try{const r=await fetch('/api/admin/scan-logs',{credentials:'same-origin'});if(r.ok)dashboardData.scans=(await r.json()).slice(0,4);}catch{}
}

function metricCard(label,value,sub='',tone=''){
  return `<div class="admin-metric ${tone}"><div class="admin-metric-label">${label}</div><div class="admin-metric-value">${value}</div>${sub?`<div class="admin-metric-sub">${sub}</div>`:''}</div>`;
}

function statusPill(text,tone='ok'){
  return `<span class="admin-pill ${tone}">${text}</span>`;
}

function renderAdminSystemPanel(){
  if(!sysStats)return `<div class="admin-panel"><div class="admin-panel-title">System Health</div><div class="admin-empty">System stats are unavailable.</div></div>`;
  const s=sysStats;
  const disk=s.disks&&s.disks.length?s.disks[0]:null;
  return `<div class="admin-panel admin-panel-wide">
    <div class="admin-panel-head"><div><div class="admin-eyebrow">Live Machine</div><h2>System Health</h2></div>${statusPill(s.activeTranscodes>0?s.activeTranscodes+' transcodes':'Idle','ok')}</div>
    <div class="admin-health-grid">
      ${metricCard('CPU',s.cpu.percent+'%',s.cpu.cores+' cores · load '+s.cpu.loadAvg[0].toFixed(1),barClass(s.cpu.percent))}
      ${metricCard('Memory',s.memory.percent+'%',fmtBytes(s.memory.free)+' free',barClass(s.memory.percent))}
      ${disk?metricCard('Disk '+esc(disk.mount),disk.percent+'%',fmtBytes(disk.available)+' free',barClass(disk.percent)):''}
      ${metricCard('Uptime',fmtUptime(s.uptime)||'Fresh start','Server process')}
    </div>
  </div>`;
}

function renderAdminLibraryPanel(){
  const files=statsData?.totalFiles||library.length;
  const movies=statsData?.movies||library.filter(i=>i.type==='movie').length;
  const shows=statsData?.shows||library.filter(i=>i.type==='show').length;
  const episodes=statsData?.episodes||library.filter(i=>i.type==='show').length;
  const folderCount=folderConfig.length;
  return `<div class="admin-panel">
    <div class="admin-panel-head"><div><div class="admin-eyebrow">Media</div><h2>Library</h2></div>${currentRole==='admin'?statusPill(folderCount+' folders','info'):''}</div>
    <div class="admin-mini-grid">
      ${metricCard('Files',files.toLocaleString())}
      ${metricCard('Movies',movies.toLocaleString())}
      ${metricCard('Shows',shows.toLocaleString())}
      ${metricCard('Episodes',episodes.toLocaleString())}
    </div>
    <div class="admin-actions">
      ${hasPerm('canScan')?'<button class="btn btn-primary btn-sm" onclick="scanLibrary(event)">Scan Library</button>':''}
      ${currentRole==='admin'?'<button class="btn btn-secondary btn-sm" onclick="nav(\'settings\',document.querySelector(\'[data-view=settings]\'))">Manage Folders</button>':''}
    </div>
  </div>`;
}

function renderAdminWatchingPanel(){
  const viewers=nowWatchingData||[];
  const body=viewers.length?viewers.slice(0,4).map(v=>{
    const pct=v.duration?Math.round(v.currentTime/v.duration*100):0;
    return `<div class="admin-list-row"><div class="admin-list-icon">${esc((v.profileName||'?').charAt(0).toUpperCase())}</div><div class="admin-list-body"><strong>${esc(v.title)}</strong><span>${esc(v.profileName||'Unknown')} · ${pct}%</span><div class="admin-row-bar"><div style="width:${pct}%"></div></div></div></div>`;
  }).join(''):`<div class="admin-empty">Nobody is watching right now. Peaceful little server moment.</div>`;
  return `<div class="admin-panel">
    <div class="admin-panel-head"><div><div class="admin-eyebrow">Activity</div><h2>Now Watching</h2></div>${statusPill(viewers.length?viewers.length+' live':'Idle',viewers.length?'live':'ok')}</div>
    <div class="admin-list">${body}</div>
    ${(currentRole==='admin'||hasPerm('canLogs'))?'<div class="admin-actions"><button class="btn btn-secondary btn-sm" onclick="nav(\'logs\',document.querySelector(\'[data-view=logs]\'))">Open Logs</button></div>':''}
  </div>`;
}

function renderAdminDownloadsPanel(){
  if(!(currentRole==='admin'||hasPerm('canDownload')))return '';
  const d=dashboardData.downloads;
  if(!d)return `<div class="admin-panel"><div class="admin-panel-title">Downloads</div><div class="admin-empty">Downloads are loading...</div></div>`;
  const active=d.torrents.filter(t=>t.progress<1);
  const speed=d.torrents.reduce((sum,t)=>sum+(t.dlspeed||0),0);
  return `<div class="admin-panel">
    <div class="admin-panel-head"><div><div class="admin-eyebrow">qBittorrent</div><h2>Downloads</h2></div>${statusPill(d.connected?'Connected':'Offline',d.connected?'ok':'bad')}</div>
    <div class="admin-mini-grid">
      ${metricCard('Active',active.length)}
      ${metricCard('Total',d.torrents.length)}
      ${metricCard('Speed',dlFormatSpeed(speed)||'0 B/s')}
      ${metricCard('Complete',d.torrents.filter(t=>t.progress>=1).length)}
    </div>
    ${!d.connected?`<div class="admin-empty">${esc(d.error||'qBittorrent is not connected.')}</div>`:''}
    <div class="admin-actions"><button class="btn btn-secondary btn-sm" onclick="nav('downloads',document.querySelector('[data-view=downloads]'))">Open Downloads</button></div>
  </div>`;
}

function renderAdminMaintenancePanel(){
  const corruptedCount=corruptedData?.length||0;
  const sprite=spriteProgress;
  const spriteTone=!sprite?'info':!sprite.enabled?'warn':sprite.running?'live':'ok';
  return `<div class="admin-panel">
    <div class="admin-panel-head"><div><div class="admin-eyebrow">Care & Feeding</div><h2>Maintenance</h2></div>${statusPill(corruptedCount?corruptedCount+' corrupted':'Clean',corruptedCount?'bad':'ok')}</div>
    <div class="admin-mini-grid">
      ${metricCard('Sprites',sprite?`${sprite.percent}%`:'--',sprite?sprite.completed+' / '+sprite.total:'Unavailable',spriteTone)}
      ${metricCard('Corrupted',corruptedCount,corruptedCount?'Needs review':'None detected',corruptedCount?'bad':'ok')}
      ${metricCard('Scans',dashboardData.scans?.length||0,'Recent entries')}
      ${metricCard('Errors',dashboardData.errors?.length||0,'Recent entries',dashboardData.errors?.length?'bad':'ok')}
    </div>
    <div class="admin-actions">
      ${currentRole==='admin'?'<button class="btn btn-secondary btn-sm" onclick="nav(\'settings\',document.querySelector(\'[data-view=settings]\'))">Maintenance Tools</button>':''}
      ${(currentRole==='admin'||hasPerm('canLogs'))?'<button class="btn btn-secondary btn-sm" onclick="nav(\'logs\',document.querySelector(\'[data-view=logs]\'))">Review Logs</button>':''}
    </div>
  </div>`;
}

function renderAdminDockerPanel(){
  if(currentRole!=='admin'||!dashboardData.docker)return '';
  const d=dashboardData.docker;
  const row=(name,label)=>`<div class="admin-service-row"><div><strong>${label}</strong><span>${name}</span></div>${statusPill(d[name]||'unknown',d[name]==='running'?'ok':'bad')}</div>`;
  return `<div class="admin-panel">
    <div class="admin-panel-head"><div><div class="admin-eyebrow">Services</div><h2>Containers</h2></div></div>
    <div class="admin-service-list">${row('gluetun','VPN Tunnel')}${row('qbittorrent','Torrent Client')}</div>
    <div class="admin-actions"><button class="btn btn-secondary btn-sm" onclick="nav('settings',document.querySelector('[data-view=settings]'))">Container Controls</button></div>
  </div>`;
}

function renderAdminRecentPanel(){
  if(!(currentRole==='admin'||hasPerm('canLogs')))return '';
  const errors=dashboardData.errors||[];
  const scans=dashboardData.scans||[];
  const items=[
    ...errors.map(e=>({type:'Error',tone:'bad',title:e.message,meta:e.context+' · '+fmtDate(e.timestamp)})),
    ...scans.map(e=>({type:'Scan',tone:'info',title:(e.count||0).toLocaleString()+' files scanned',meta:(e.trigger||'scan')+' · '+fmtDate(e.timestamp)})),
  ].slice(0,6);
  const body=items.length?items.map(i=>`<div class="admin-list-row compact"><div class="admin-dot ${i.tone}"></div><div class="admin-list-body"><strong>${esc(i.title)}</strong><span>${esc(i.type)} · ${esc(i.meta)}</span></div></div>`).join(''):'<div class="admin-empty">No recent scan or error events.</div>';
  return `<div class="admin-panel admin-panel-wide">
    <div class="admin-panel-head"><div><div class="admin-eyebrow">Signals</div><h2>Recent Events</h2></div><button class="btn btn-secondary btn-sm" onclick="nav('logs',document.querySelector('[data-view=logs]'))">Open Logs</button></div>
    <div class="admin-list">${body}</div>
  </div>`;
}

function buildAdminDashboardHtml(){
  const canRestart=currentRole==='admin'||hasPerm('canRestart');
  return `<div class="admin-dashboard">
    <div class="admin-hero">
      <div>
        <div class="admin-eyebrow">Control Center</div>
        <h1>System Dashboard</h1>
        <p>Server health, library operations, downloads, logs, and maintenance in one place.</p>
      </div>
      <div class="admin-hero-actions">
        ${hasPerm('canScan')?'<button class="btn btn-primary" onclick="scanLibrary(event)">Scan Library</button>':''}
        ${canRestart?'<button class="btn btn-secondary" onclick="restartServer()">Restart Server</button>':''}
      </div>
    </div>
    <div class="admin-grid">
      ${renderAdminSystemPanel()}
      ${renderAdminLibraryPanel()}
      ${renderAdminWatchingPanel()}
      ${renderAdminDownloadsPanel()}
      ${currentRole==='admin'?renderAdminMaintenancePanel():''}
      ${renderAdminDockerPanel()}
      ${renderAdminRecentPanel()}
    </div>
  </div>`;
}

async function renderAdminDashboard(){
  const a=document.getElementById('contentArea');
  a.innerHTML='<div class="admin-dashboard"><div class="admin-loading"><span class="dl-spinner" style="width:28px;height:28px;border-width:3px"></span><p>Loading control center...</p></div></div>';
  await fetchDashboardData();
  a.innerHTML=buildAdminDashboardHtml();
  startDashboardRefresh();
}

function startDashboardRefresh(){
  clearInterval(window._dashboardInterval);
  window._dashboardInterval=setInterval(async()=>{
    if(currentView!=='system'){clearInterval(window._dashboardInterval);return;}
    await fetchDashboardData();
    if(currentView==='system')document.getElementById('contentArea').innerHTML=buildAdminDashboardHtml();
  },15000);
}
async function renderSettings(){
  await Promise.all([fetchConfig(),fetchStats(),fetchSpriteProgress(),fetchSysStats(),fetchCorrupted(),fetchNowWatching()]);
  const a=document.getElementById('contentArea');

  let fh='';
  if(folderConfig.length===0)fh='<div style="text-align:center;padding:24px 0;color:var(--text-muted)">No folders linked yet.</div>';
  else{
    fh='<div class="folder-list">';
    for(const f of folderConfig){
      const ti={movie:'▣',show:'▤',auto:'▱'};
      const tl={movie:'Movies',show:'TV Shows',auto:'Auto-detect'};
      const icon=ti[f.type]||customTypeIcon(f.type);
      const typeLabel=tl[f.type]||customTypeLabel(f.type);
      fh+=`<div class="folder-card"><div class="folder-card-icon ${f.type}">${icon}</div><div class="folder-card-body"><div class="folder-card-label">${esc(f.label)}</div><div class="folder-card-path" title="${esc(f.path)}">${esc(f.path)}</div><div class="folder-card-meta"><span class="folder-meta-tag ${f.type}">${typeLabel}</span><span class="folder-meta-count">${f.fileCount||0} videos</span><span class="folder-card-status ${f.exists?'ok':'err'}">${f.exists?'✓ Connected':'✗ Not found'}</span></div></div><button class="btn btn-danger btn-sm" onclick="removeFolder('${escAttr(f.path)}')">Remove</button></div>`;
    }
    fh+='</div>';
  }

  // Stats
  let sh='';
  if(statsData){
    const sz=formatSize(statsData.totalSize);
    let customStats='';
    if(statsData.customTypes){for(const[t,c]of Object.entries(statsData.customTypes)){customStats+=`<div class="stat-card"><div class="stat-value">${c}</div><div class="stat-label">${customTypeLabel(t)}</div></div>`;}}
    sh=`<h3 style="font-size:1rem;font-weight:700;margin:20px 0 12px">Library Stats</h3><div class="stats-grid"><div class="stat-card"><div class="stat-value">${statsData.totalFiles}</div><div class="stat-label">Total Files</div></div><div class="stat-card"><div class="stat-value">${statsData.movies}</div><div class="stat-label">Movies</div></div><div class="stat-card"><div class="stat-value">${statsData.shows}</div><div class="stat-label">Shows</div></div><div class="stat-card"><div class="stat-value">${statsData.episodes}</div><div class="stat-label">Episodes</div></div>${customStats}<div class="stat-card"><div class="stat-value">${sz}</div><div class="stat-label">Total Size</div></div></div>`;
    if(Object.keys(statsData.byFolder).length){
      sh+='<div style="margin-bottom:20px">';
      for(const[name,info]of Object.entries(statsData.byFolder)){
        sh+=`<div class="folder-stat"><span class="folder-stat-name">${esc(name)}</span><span class="folder-stat-info">${info.count} files · ${formatSize(info.size)}</span></div>`;
      }
      sh+='</div>';
    }
  }

  // Sprite progress
  let sph='';
  if(spriteProgress){
    const sp=spriteProgress;
    const paused=!sp.enabled;
    const badge=paused?'<span class="sprite-badge paused">Paused</span>':sp.running?'<span class="sprite-badge running">Generating</span>':'<span class="sprite-badge done">Complete</span>';
    const toggleBtn=`<button class="btn btn-sm ${paused?'btn-primary':'btn-secondary'}" onclick="toggleSpriteGen()" style="font-size:.75rem;padding:4px 12px">${paused?'&#9654; Start Sprites':'&#9646;&#9646; Stop Sprites'}</button>`;
    sph=`<h3 style="font-size:1rem;font-weight:700;margin:20px 0 12px">Thumbnail Sprites</h3><div class="sprite-progress${paused?' paused':''}"><div class="sprite-progress-title"><span>Progress</span><div style="display:flex;align-items:center;gap:8px">${badge}${toggleBtn}</div></div><div class="sprite-progress-bar"><div class="sprite-progress-fill" style="width:${sp.percent}%"></div></div><div class="sprite-progress-info"><span>${sp.completed} / ${sp.total} media</span><span>${sp.percent}%</span></div>${!paused&&sp.running&&sp.current?`<div class="sprite-progress-current">Currently: ${esc(sp.current)}</div>`:paused?'<div class="sprite-progress-current">Paused — click Start Sprites to resume</div>':''}</div>`;
  }

  const sysh=renderSysStats();
  const cph=`<div id="corruptedSection">${renderCorruptedSection()}</div>`;
  const tsh=``;

  // Docker container controls
  let dockerStatus={qbittorrent:'unknown',gluetun:'unknown'};
  try{const r=await adminFetch('/api/docker/status');if(r.ok)dockerStatus=await r.json();}catch{}
  function dockerBadge(s){
    if(s==='running')return`<span style="background:#1a3a1a;color:#4caf50;border:1px solid #4caf50;border-radius:20px;padding:2px 9px;font-size:.72rem;font-weight:600">● running</span>`;
    if(s==='exited'||s==='stopped')return`<span style="background:#3a1a1a;color:#f44336;border:1px solid #f44336;border-radius:20px;padding:2px 9px;font-size:.72rem;font-weight:600">● stopped</span>`;
    return`<span style="background:rgba(255,255,255,.07);color:var(--text-muted);border-radius:20px;padding:2px 9px;font-size:.72rem">● ${s}</span>`;
  }
  function dockerBtns(name,s){
    const running=s==='running';
    return running
      ?`<button class="btn btn-sm" onclick="dockerAction('stop','${name}')" style="font-size:.75rem;padding:5px 11px;background:#c0392b">Stop</button><button class="btn btn-sm" onclick="dockerAction('restart','${name}')" style="font-size:.75rem;padding:5px 11px">Restart</button>`
      :`<button class="btn btn-sm" onclick="dockerAction('start','${name}')" style="font-size:.75rem;padding:5px 11px;background:#27ae60">Start</button>`;
  }
  const dockerh=`<h3 style="font-size:1rem;font-weight:700;margin:28px 0 12px">Docker Containers</h3>
  <div style="display:flex;flex-direction:column;gap:8px" id="dockerSection">
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-card);border-radius:10px;border:1px solid rgba(255,255,255,.06)">
      <div style="font-size:1.3rem">&#127758;</div>
      <div style="flex:1"><div style="font-weight:600;font-size:.9rem">gluetun</div><div style="font-size:.75rem;color:var(--text-muted)">VPN tunnel</div></div>
      ${dockerBadge(dockerStatus.gluetun)}<div style="display:flex;gap:6px">${dockerBtns('gluetun',dockerStatus.gluetun)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-card);border-radius:10px;border:1px solid rgba(255,255,255,.06)">
      <div style="font-size:1.3rem">&#127987;</div>
      <div style="flex:1"><div style="font-weight:600;font-size:.9rem">qbittorrent</div><div style="font-size:.75rem;color:var(--text-muted)">Torrent client (via gluetun)</div></div>
      ${dockerBadge(dockerStatus.qbittorrent)}<div style="display:flex;gap:6px">${dockerBtns('qbittorrent',dockerStatus.qbittorrent)}</div>
    </div>
  </div>`;

  // Accounts section (admin only)
  let acctHtml='';
  if(currentRole==='admin'){
    const profiles=await loadProfiles();
    let rows=profiles.map(p=>{
      const perms=p.permissions||[];
      let roleBadge;
      if(p.role==='admin'){
        roleBadge='<span style="background:var(--accent);color:#fff;padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:700">ADMIN</span>';
      } else {
        const permTags=[];
        if(perms.includes('canDownload'))permTags.push('<span style="background:rgba(59,130,246,.2);color:#60a5fa;padding:2px 6px;border-radius:4px;font-size:.65rem;font-weight:600">DL</span>');
        if(perms.includes('canScan'))permTags.push('<span style="background:rgba(16,185,129,.2);color:#34d399;padding:2px 6px;border-radius:4px;font-size:.65rem;font-weight:600">SCAN</span>');
        if(perms.includes('canRestart'))permTags.push('<span style="background:rgba(245,158,11,.2);color:#fbbf24;padding:2px 6px;border-radius:4px;font-size:.65rem;font-weight:600">RST</span>');
        if(perms.includes('canLogs'))permTags.push('<span style="background:rgba(168,85,247,.2);color:#c084fc;padding:2px 6px;border-radius:4px;font-size:.65rem;font-weight:600">LOGS</span>');
        roleBadge='<span style="background:rgba(255,255,255,.1);color:var(--text-secondary);padding:2px 8px;border-radius:4px;font-size:.7rem;font-weight:700">USER</span>'+(permTags.length?' '+permTags.join(' '):'');
      }
      const lockIcon=p.hasPassword?'&#128274;':'<span style="color:var(--text-muted)">None</span>';
      const isDefault=profiles.length<=1;
      const deleteBtn=isDefault?'':`<button class="btn btn-danger btn-sm" onclick="deleteAccount('${escAttr(p.id)}','${escAttr(p.name)}')" style="padding:4px 10px;font-size:.75rem">Delete</button>`;
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--bg-card);border-radius:10px;border:1px solid rgba(255,255,255,.06)"><div style="width:40px;height:40px;border-radius:10px;background:${p.avatar};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.1rem;color:#fff;flex-shrink:0">${p.name[0].toUpperCase()}</div><div style="flex:1;min-width:0"><div style="font-weight:600;font-size:.9rem">${esc(p.name)}</div><div style="font-size:.75rem;color:var(--text-muted);margin-top:2px">@${esc(p.username||'')} &middot; Password: ${lockIcon}</div></div><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${roleBadge}<button class="btn btn-secondary btn-sm" onclick="editAccount('${escAttr(p.id)}')" style="padding:4px 10px;font-size:.75rem">Edit</button>${deleteBtn}</div></div>`;
    }).join('');
    acctHtml=`<h3 style="font-size:1rem;font-weight:700;margin:28px 0 12px">Accounts</h3><div style="display:flex;flex-direction:column;gap:8px">${rows}<div style="margin-top:8px"><button class="btn btn-primary btn-sm" onclick="createProfile()">&#10010; Add Account</button></div></div>`;
  }

  // Populate datalist with existing custom types
  const existingTypes=new Set(folderConfig.map(f=>f.type));
  getCustomTypes().forEach(t=>existingTypes.add(t));
  let dtOpts='<option value="movie">Movies</option><option value="show">TV Shows</option><option value="auto">Auto-detect</option>';
  for(const t of existingTypes){if(t!=='movie'&&t!=='show'&&t!=='auto')dtOpts+=`<option value="${esc(t)}">${customTypeLabel(t)}</option>`;}

  a.innerHTML=`<div class="settings"><h1 class="settings-title">Media Folders</h1><p class="settings-subtitle">Link folders from anywhere on this computer. Use movie, show, auto, or type a custom category (e.g. anime).</p><div id="settingsAlert" class="alert"></div>${fh}<div class="add-folder-section"><h3>&#10010; Link a New Folder</h3><div class="form-row"><div class="form-group grow"><label class="form-label">Folder path</label><input class="form-input" type="text" id="addFolderPath" placeholder="/path/to/movies" oninput="onPathInput(this.value)"></div><div class="form-group"><label class="form-label">Type</label><input class="form-input" type="text" id="addFolderType" list="folderTypeList" value="auto" placeholder="movie, show, anime..." style="width:140px"><datalist id="folderTypeList">${dtOpts}</datalist></div><div class="form-group"><label class="form-label">Label</label><input class="form-input" type="text" id="addFolderLabel" placeholder="My Movies" style="width:140px"></div></div><div id="folderBrowser"></div><div style="display:flex;gap:8px;margin-top:4px"><button class="btn btn-primary btn-sm" onclick="addFolder()">&#10010; Link Folder</button><button class="btn btn-secondary btn-sm" onclick="toggleBrowser()">▱ Browse</button></div></div>${sh}${sph}${tsh}${cph}${sysh}${dockerh}${acctHtml}</div>`;
  // Auto-refresh sprite progress + system stats
  startSettingsRefresh();
  if(folderConfig.length===0)toggleBrowser();
}

let statsData=null;
async function fetchStats(){try{statsData=await(await fetch('/api/stats')).json();}catch{statsData=null;}}

function updateSpriteProgress(){
  const el=document.querySelector('.sprite-progress');
  if(!el||!spriteProgress)return;
  const sp=spriteProgress;
  const paused=!sp.enabled;
  const badge=paused?'<span class="sprite-badge paused">Paused</span>':sp.running?'<span class="sprite-badge running">Generating</span>':'<span class="sprite-badge done">Complete</span>';
  const toggleBtn=`<button class="btn btn-sm ${paused?'btn-primary':'btn-secondary'}" onclick="toggleSpriteGen()" style="font-size:.75rem;padding:4px 12px">${paused?'&#9654; Start Sprites':'&#9646;&#9646; Stop Sprites'}</button>`;
  if(paused)el.classList.add('paused');else el.classList.remove('paused');
  el.innerHTML=`<div class="sprite-progress-title"><span>Progress</span><div style="display:flex;align-items:center;gap:8px">${badge}${toggleBtn}</div></div><div class="sprite-progress-bar"><div class="sprite-progress-fill" style="width:${sp.percent}%"></div></div><div class="sprite-progress-info"><span>${sp.completed} / ${sp.total} media</span><span>${sp.percent}%</span></div>${!paused&&sp.running&&sp.current?`<div class="sprite-progress-current">Currently: ${esc(sp.current)}</div>`:paused?'<div class="sprite-progress-current">Paused — click Start Sprites to resume</div>':''}`;
}
async function toggleSpriteGen(){
  if(!spriteProgress)return;
  const endpoint=spriteProgress.enabled?'/api/sprites/pause':'/api/sprites/resume';
  try{
    const r=await adminFetch(endpoint,{method:'POST'});
    if(!r.ok)return;
    const d=await r.json();
    spriteProgress.enabled=d.enabled;
    if(!d.enabled)spriteProgress.running=false;
    updateSpriteProgress();
  }catch{}
}
function updateSysStats(){
  const el=document.getElementById('sysStatsGrid');
  if(!el||!sysStats)return;
  // Re-render just the grid content
  const tmp=document.createElement('div');
  tmp.innerHTML=renderSysStats();
  const newGrid=tmp.querySelector('#sysStatsGrid');
  if(newGrid)el.innerHTML=newGrid.innerHTML;
}
function startSettingsRefresh(){
  clearInterval(window._settingsInterval);
  window._settingsInterval=setInterval(async()=>{
    if(currentView!=='settings'){clearInterval(window._settingsInterval);return;}
    await Promise.all([fetchSpriteProgress(),fetchSysStats(),fetchCorrupted()]);
    updateSpriteProgress();
    updateSysStats();
    updateCorruptedSection();
  },3000);
}

let browserOpen=false;
function toggleBrowser(){browserOpen=!browserOpen;if(browserOpen){browseTo(document.getElementById('addFolderPath')?.value||'~');}else{const el=document.getElementById('folderBrowser');if(el)el.innerHTML='';}}
async function browseTo(p){
  try{const r=await adminFetch(`/api/browse?path=${encodeURIComponent(p)}`);if(!r.ok)throw 0;const d=await r.json();browserPath=d.current;browserData=d;renderBrowser();}
  catch{const el=document.getElementById('folderBrowser');if(el)el.innerHTML='<div style="padding:12px;color:var(--danger);font-size:.83rem">Cannot access directory.</div>';}
}
let browserPath='',browserData=null;
function renderBrowser(){
  if(!browserData)return;const d=browserData;let items='';
  if(d.parent&&d.parent!==d.current)items+=`<div class="browser-item parent" onclick="browseTo('${escAttr(d.parent)}')" onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="Browse parent folder"><span class="browser-item-icon">&#11168;</span><span class="browser-item-name">..</span></div>`;
  for(const dir of d.dirs){const fp=d.current+(d.current.endsWith('/')?'':'/')+dir;items+=`<div class="browser-item" onclick="browseTo('${escAttr(fp)}')" onkeydown="activateWithKeyboard(event)" role="button" tabindex="0" aria-label="Browse ${escAttr(dir)}"><span class="browser-item-icon">&#128194;</span><span class="browser-item-name">${esc(dir)}</span></div>`;}
  const vc=d.videoCount>0?`<span class="browser-video-count">${d.videoCount} video${d.videoCount===1?'':'s'}</span>`:'';
  const el=document.getElementById('folderBrowser');
  if(el)el.innerHTML=`<div class="browser-panel"><div class="browser-path-bar">&#128194; <span>${esc(d.current)}</span>${vc}</div><div class="browser-list">${items}</div><div class="browser-actions"><span class="browser-selected">Selected: ${esc(d.current)}</span><button class="btn btn-primary btn-sm" onclick="selectBrowserPath()">&#10003; Use This</button></div></div>`;
}
function selectBrowserPath(){if(!browserPath)return;document.getElementById('addFolderPath').value=browserPath;const l=document.getElementById('addFolderLabel');if(!l.value){const p=browserPath.replace(/\/+$/,'').split('/');l.value=p[p.length-1]||'';}browserOpen=false;const el=document.getElementById('folderBrowser');if(el)el.innerHTML='';}
function onPathInput(v){if(browserOpen&&v.length>2){clearTimeout(window._bt);window._bt=setTimeout(()=>browseTo(v),400);}}
async function addFolder(){
  const p=document.getElementById('addFolderPath'),t=document.getElementById('addFolderType'),l=document.getElementById('addFolderLabel');
  if(!p.value.trim()){showSettingsAlert('Enter a folder path.','error');return;}
  try{const r=await adminFetch('/api/config/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:p.value.trim(),type:t.value,label:l.value.trim()})});const d=await r.json();if(!r.ok){showSettingsAlert(d.error||'Error','error');return;}
  showSettingsAlert('Folder linked!','success');p.value='';t.value='auto';l.value='';browserOpen=false;await renderSettings();fetchLib();}catch{showSettingsAlert('Server error.','error');}
}
async function removeFolder(fp){try{await adminFetch('/api/config/remove',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:fp})});await renderSettings();fetchLib();}catch{}}
function showSettingsAlert(m,t){const e=document.getElementById('settingsAlert');if(!e)return;e.className=`alert ${t}`;e.textContent=m;setTimeout(()=>{e.className='alert';},3500);}

function scanLibrary(e){
  const rawTarget=e&&e.target?e.target:event.target;
  const btn=rawTarget.closest('.nav-item')||rawTarget.closest('button');
  const orig=btn?btn.innerHTML:'';
  if(btn){btn.innerHTML='<span class="nav-icon">↻</span> Scanning...';btn.disabled=true;}
  adminFetch('/api/scan',{method:'POST'}).then(r=>r.json()).then(d=>{
    if(d.ok){
      // Poll until scan completes by waiting for library-updated SSE event
      // Meanwhile just show scanning state, the SSE handler will refresh
      setTimeout(()=>{if(btn){btn.innerHTML=orig;btn.disabled=false;}fetchLib();},2000);
    } else {
      if(btn){btn.innerHTML=orig;btn.disabled=false;}showToast(d.message||'Scan failed','error');
    }
  }).catch(()=>{if(btn){btn.innerHTML=orig;btn.disabled=false;}showToast('Failed to reach server.','error');});
}

function restartServer(){
  if(!confirm('Restart the server? Playback will be interrupted.'))return;
  adminFetch('/api/restart',{method:'POST'}).then(()=>{
    document.getElementById('contentArea').innerHTML='<div class="empty-state"><div class="empty-icon">&#128260;</div><div class="empty-title">Restarting Server...</div><div class="empty-text">Reconnecting automatically...</div></div>';
    const poll=setInterval(()=>{
      fetch('/api/stats').then(r=>{if(r.ok){clearInterval(poll);location.reload();}}).catch(()=>{});
    },1000);
  }).catch(()=>{showToast('Failed to reach server.','error');});
}

// ══════════════════════════════════════════════════════════════════════
// Video Player
// ══════════════════════════════════════════════════════════════════════
function getPlaylist(){
  if(!currentMedia)return[];
  let list;
  if(currentMedia.showName){
    // Show-like content (TV shows or custom types with showName): group by showName and type
    list=library.filter(m=>m.type===currentMedia.type&&m.showName===currentMedia.showName);
    list.sort((a,b)=>{
      const sa=a.epInfo?a.epInfo.season:0, sb=b.epInfo?b.epInfo.season:0;
      if(sa!==sb)return sa-sb;
      const ea=a.epInfo?a.epInfo.episode:0, eb=b.epInfo?b.epInfo.episode:0;
      if(ea!==eb)return ea-eb;
      return (a.filename||a.title||'').localeCompare(b.filename||b.title||'',undefined,{numeric:true});
    });
  } else {
    list=library.filter(m=>m.folder===currentMedia.folder&&m.type===currentMedia.type);
    list.sort((a,b)=>(a.filename||a.title||'').localeCompare(b.filename||b.title||'',undefined,{numeric:true}));
  }
  return list;
}
function getCurIdx(){return getPlaylist().findIndex(m=>m.id===currentMedia.id);}

function updateEpBtns(){
  const pl=getPlaylist(),idx=getCurIdx();
  document.getElementById('prevEpBtn').classList.toggle('disabled',idx<=0);
  document.getElementById('nextEpBtn').classList.toggle('disabled',pl.length<=1||idx>=pl.length-1);
  document.getElementById('epInfo').textContent=pl.length>1?`${idx+1}/${pl.length}`:'';
}

function playNextEp(){const pl=getPlaylist(),i=getCurIdx();if(i<pl.length-1){saveProg();playMedia(pl[i+1].id);}}
function playPrevEp(){const pl=getPlaylist(),i=getCurIdx();if(i>0){saveProg();playMedia(pl[i-1].id);}}

function skipBack(){if(_castMedia&&_castSession){const t=(_castMedia.getEstimatedTime?_castMedia.getEstimatedTime():_castMedia.currentTime||0);castSeek(Math.max(0,t-skipInterval));return;}V.currentTime=Math.max(0,V.currentTime-skipInterval);}
function skipFwd(){if(_castMedia&&_castSession){const t=(_castMedia.getEstimatedTime?_castMedia.getEstimatedTime():_castMedia.currentTime||0);const d=_castMedia.media?.duration||0;castSeek(Math.min(d,t+skipInterval));return;}V.currentTime=Math.min(V.duration||0,V.currentTime+skipInterval);}

function setSkip(v){
  skipInterval=v;document.getElementById('skipIntervalBtn').textContent=v+'s';
  document.getElementById('skipBackBtn').title=`Rewind ${v}s`;document.getElementById('skipFwdBtn').title=`Forward ${v}s`;
  document.querySelectorAll('#skipMenu .menu-option').forEach(e=>e.classList.toggle('active',parseInt(e.textContent)===v));closeMenus();
}
function setSpd(v){
  playbackSpeed=v;V.playbackRate=v;document.getElementById('speedBtn').textContent=v+'x';
  document.querySelectorAll('#speedMenu .menu-option').forEach(e=>e.classList.toggle('active',parseFloat(e.textContent)===v));closeMenus();
}

function updateVolumeUI(){
  const muted=V.muted||V.volume===0;
  document.getElementById('volumeBtn').innerHTML=muted?'&#128263;':V.volume<.5?'&#128265;':'&#128266;';
  document.getElementById('volumeSlider').value=muted?0:V.volume;
}

function getAudioContextCtor(){
  return window.AudioContext||window.webkitAudioContext||null;
}

function updateBoostUI(){
  const btn=document.getElementById('boostBtn');
  const slider=document.getElementById('boostSlider');
  const level=document.getElementById('boostLevel');
  const hint=document.getElementById('boostHint');
  if(slider)slider.value=audioBoostLevel.toFixed(1);
  if(level)level.textContent=audioBoostLevel.toFixed(1)+'x';
  if(btn){
    btn.classList.toggle('boost-active',audioBoostLevel>1.01);
    btn.title=audioBoostLevel>1.01?`Audio Boost (${audioBoostLevel.toFixed(1)}x)`:'Audio Boost';
  }
  if(hint){
    if(!getAudioContextCtor())hint.textContent='Audio boost is not supported in this browser.';
    else if(audioBoostError)hint.textContent=audioBoostError;
    else hint.textContent='Boost quiet audio up to 3x when needed.';
  }
}

function syncAudioBoostGain(){
  window._audioBoostLevel=audioBoostLevel;
  if(audioBoostGain)audioBoostGain.gain.value=V.muted?0:audioBoostLevel;
  updateBoostUI();
}

async function ensureAudioBoostReady(){
  const AudioCtx=getAudioContextCtor();
  if(!AudioCtx){
    audioBoostError='Audio boost is not supported in this browser.';
    updateBoostUI();
    return false;
  }
  try{
    if(!audioBoostContext){
      audioBoostContext=new AudioCtx();
      audioBoostSource=audioBoostContext.createMediaElementSource(V);
      audioBoostGain=audioBoostContext.createGain();
      audioBoostSource.connect(audioBoostGain);
      audioBoostGain.connect(audioBoostContext.destination);
      window._audioBoostGainNode=audioBoostGain;
    }
    if(audioBoostContext.state==='suspended')await audioBoostContext.resume();
    audioBoostError='';
    syncAudioBoostGain();
    return true;
  }catch(err){
    console.warn('[AudioBoost] Failed to initialize:',err);
    audioBoostError='Audio boost is unavailable right now.';
    updateBoostUI();
    return false;
  }
}

async function setBoost(v){
  const next=Math.max(1,Math.min(3,Number(v)||1));
  audioBoostLevel=Math.round(next*10)/10;
  updateBoostUI();
  const ready=await ensureAudioBoostReady();
  if(ready)syncAudioBoostGain();
}

// Subtitles
function buildSubMenu(){
  const menu=document.getElementById('subMenu');
  let html='<div class="menu-option active" onclick="setSub(-1)">Off</div>';
  if(currentMedia&&currentMedia.subtitles){
    currentMedia.subtitles.forEach((s,i)=>{
      html+=`<div class="menu-option" onclick="setSub(${i})">${esc(s.label)}</div>`;
    });
  }
  menu.innerHTML=html;
}

function setSub(idx){
  // Remove existing tracks
  V.querySelectorAll('track').forEach(t=>t.remove());
  document.querySelectorAll('#subMenu .menu-option').forEach((e,i)=>e.classList.toggle('active',i===(idx+1)));
  if(idx>=0&&currentMedia&&currentMedia.subtitles[idx]){
    const track=document.createElement('track');
    track.kind='subtitles';track.label=currentMedia.subtitles[idx].label;
    track.src=currentMedia.subtitles[idx].url;track.default=true;
    V.appendChild(track);
    // Enable the track
    setTimeout(()=>{if(V.textTracks[0])V.textTracks[0].mode='showing';},200);
    document.getElementById('videoWrapper').classList.add('subs-active');
  } else {
    document.getElementById('videoWrapper').classList.remove('subs-active');
  }
  closeMenus();
}

// Audio track selection
let _currentAudioTrack=null; // null = default (first track)

function buildAudioMenu(){
  const menu=document.getElementById('audioMenu');
  let html='<div class="menu-option active" onclick="setAudioTrack(-1)">Default</div>';
  const audioWrap=document.getElementById('audioBtn').closest('.ctrl-btn-wrap');
  const audioDivider=audioWrap?audioWrap.nextElementSibling:null;
  if(currentMedia&&currentMedia.audioTracks&&currentMedia.audioTracks.length>1){
    currentMedia.audioTracks.forEach((t,i)=>{
      html+=`<div class="menu-option" onclick="setAudioTrack(${t.index})">${esc(t.label)}</div>`;
    });
    if(audioWrap)audioWrap.style.display='';
    if(audioDivider&&audioDivider.classList.contains('ctrl-divider'))audioDivider.style.display='';
  } else {
    if(audioWrap)audioWrap.style.display='none';
    if(audioDivider&&audioDivider.classList.contains('ctrl-divider'))audioDivider.style.display='none';
  }
  menu.innerHTML=html;
  _currentAudioTrack=null;
}

function setAudioTrack(streamIndex){
  if(streamIndex===-1) streamIndex=null;
  if(streamIndex===_currentAudioTrack){closeMenus();return;}
  _currentAudioTrack=streamIndex;
  // Update menu active state
  const opts=document.querySelectorAll('#audioMenu .menu-option');
  opts.forEach((e,i)=>{
    if(i===0) e.classList.toggle('active',streamIndex===null);
    else if(currentMedia&&currentMedia.audioTracks) e.classList.toggle('active',currentMedia.audioTracks[i-1]&&currentMedia.audioTracks[i-1].index===streamIndex);
  });
  // Restart HLS with new audio track — keep current playback position
  if(currentMedia){
    const currentTime=V.currentTime+(window._hlsSeekOffset||0);
    const audioParam=streamIndex!==null?'&audio='+streamIndex:'';
    const hlsUrl='/hls/'+currentMedia.id+'/master.m3u8?start='+currentTime+audioParam+'&quality='+_currentQuality;
    window._hlsLoad(hlsUrl);
  }
  closeMenus();
}

// Quality preset selection
function updateQualityUI(){
  const btn=document.getElementById('qualityBtn');
  const labels={low:'Low',auto:'Auto',high:'High'};
  if(btn)btn.textContent=labels[_currentQuality]||'Auto';
  const opts=document.querySelectorAll('#qualityMenu .menu-option');
  const order=['low','auto','high'];
  opts.forEach((e,i)=>e.classList.toggle('active',order[i]===_currentQuality));
}

async function setQuality(preset){
  if(preset===_currentQuality){closeMenus();return;}
  _currentQuality=preset;
  updateQualityUI();
  // Save preference to profile
  try{
    const r=await fetch('/api/me/quality',{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({quality:preset})});
    if(r.ok){const labels={low:'Low',auto:'Auto',high:'High'};showToast('Quality set to '+labels[preset]);}
    else{showToast('Failed to save quality');_currentQuality=preset==='low'?'auto':preset==='auto'?'high':'low';updateQualityUI();}
  }catch(e){console.error('[Quality] Save error:',e);}
  // Restart HLS with new quality — keep current playback position
  if(currentMedia&&currentMedia.streamMode&&currentMedia.streamMode!=='direct'&&typeof window._hlsLoad==='function'){
    const currentTime=V.currentTime+(window._hlsSeekOffset||0);
    const audioParam=_currentAudioTrack!=null?'&audio='+_currentAudioTrack:'';
    window._hlsLoad('/hls/'+currentMedia.id+'/master.m3u8?start='+currentTime+audioParam+'&quality='+preset);
  }
  closeMenus();
}

// Skip Segment (intro/recap/outro)
let _skipSegments=null;
let _skipSegmentDismissed={}; // track per segment type
let _markIntroStart=null,_markIntroEnd=null;

async function loadSkipSegments(id){
  _skipSegments=null;
  _skipSegmentDismissed={};
  document.getElementById('skipIntroBox').classList.remove('visible','fade-out');
  try{
    const res=await fetch('/api/skip-segments/'+id);
    const data=await res.json();
    if(data&&(data.intro||data.recap||data.outro)){
      _skipSegments=data;
      console.log('[SkipSegment] Loaded:',data);
    }
  }catch(e){console.error('[SkipSegment] Load error:',e);}
  // Show mark intro button for TV shows
  const btn=document.getElementById('markIntroBtn');
  if(btn) btn.style.display=(currentMedia&&currentMedia.type==='show')?'':'none';
}

const SKIP_SEGMENT_LEAD=3; // show popup this many seconds before segment starts

function checkSkipSegment(){
  if(!_skipSegments)return;
  const t=V.currentTime+(window._hlsSeekOffset||0);
  const box=document.getElementById('skipIntroBox');
  
  // Check each segment type in priority order: recap, intro, outro
  const segmentTypes=['recap','intro','outro'];
  const segmentLabels={recap:'Recap',intro:'Intro',outro:'Outro'};
  
  for(const type of segmentTypes){
    const seg=_skipSegments[type];
    if(!seg||_skipSegmentDismissed[type])continue;
    
    const segStart=seg.start;
    const segEnd=seg.end;
    const segDuration=segEnd-segStart;
    
    // Show popup SKIP_SEGMENT_LEAD seconds before segment, keep visible through segment
    if(t>=(segStart-SKIP_SEGMENT_LEAD)&&t<segEnd){
      box.classList.add('visible');
      box.classList.remove('fade-out');
      document.getElementById('skipSegmentTitle').textContent=segmentLabels[type]+' playing';
      document.getElementById('skipSegmentBtn').textContent='Skip '+segmentLabels[type];
      document.getElementById('skipSegmentBtn').onclick=()=>skipSegment(type);
      // Update progress bar during the segment
      if(t>=segStart){
        const pct=Math.min(100,((t-segStart)/segDuration)*100);
        document.getElementById('skipIntroProgress').style.width=pct+'%';
        document.getElementById('skipIntroLabel').textContent=segmentLabels[type]+' · '+Math.ceil(segEnd-t)+'s left';
      }else{
        document.getElementById('skipIntroProgress').style.width='0%';
        document.getElementById('skipIntroLabel').textContent=segmentLabels[type]+' starting...';
      }
      return; // Only show one segment type at a time
    }
  }
  
  // No segment active — hide if visible
  if(box.classList.contains('visible')){
    box.classList.add('fade-out');
    setTimeout(()=>{box.classList.remove('visible','fade-out');},500);
  }
}

function skipSegment(type){
  if(!_skipSegments||!_skipSegments[type])return;
  const seg=_skipSegments[type];
  const targetTime=seg.end;
  const offset=window._hlsSeekOffset||0;
  const box=document.getElementById('skipIntroBox');
  _skipSegmentDismissed[type]=true;
  box.classList.add('fade-out');
  setTimeout(()=>{box.classList.remove('visible','fade-out');},400);
  // If target is beyond current HLS range, do a full seek reload
  if(targetTime>offset+(V.duration||0)){
    const hlsUrl='/hls/'+currentMedia.id+'/master.m3u8?start='+targetTime;
    window._hlsLoad(hlsUrl);
  }else{
    V.currentTime=targetTime-offset;
  }
}

// Legacy aliases for compatibility
function skipIntro(){skipSegment('intro');}
function checkSkipIntro(){checkSkipSegment();}

function toggleMarkIntro(){
  const panel=document.getElementById('markIntroPanel');
  if(panel.classList.contains('visible')){
    panel.classList.remove('visible');
    _markIntroStart=null;_markIntroEnd=null;
  } else {
    _markIntroStart=_skipSegments?.intro?.start||null;
    _markIntroEnd=_skipSegments?.intro?.end||null;
    updateMarkIntroDisplay();
    panel.classList.add('visible');
  }
}

function markIntroPoint(which){
  const t=Math.round(V.currentTime+(window._hlsSeekOffset||0));
  if(which==='start') _markIntroStart=t;
  else _markIntroEnd=t;
  updateMarkIntroDisplay();
}

function updateMarkIntroDisplay(){
  document.getElementById('markIntroStart').textContent=_markIntroStart!==null?fmt(_markIntroStart):'--:--';
  document.getElementById('markIntroEnd').textContent=_markIntroEnd!==null?fmt(_markIntroEnd):'--:--';
}

async function saveMarkedIntro(){
  if(_markIntroStart===null||_markIntroEnd===null){showToast('Set both start and end times','error');return;}
  if(_markIntroEnd<=_markIntroStart){showToast('End must be after start','error');return;}
  const applyToShow=document.getElementById('markIntroApplyShow').checked;
  await fetch('/api/skip-segments/'+currentMedia.id,{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({intro:{start:_markIntroStart,end:_markIntroEnd},applyToShow})
  });
  _skipSegments=Object.assign({},_skipSegments,{intro:{start:_markIntroStart,end:_markIntroEnd}});
  document.getElementById('markIntroPanel').classList.remove('visible');
  console.log('[SkipIntro] Saved:',_markIntroStart+'s -',_markIntroEnd+'s',applyToShow?'(all episodes)':'(this episode)');
}

async function autoDetectIntro(){
  const btn=document.getElementById('autoDetectBtn');
  btn.textContent='Detecting...';
  btn.disabled=true;
  try{
    const res=await fetch('/api/detect-intro/'+currentMedia.id,{method:'POST'});
    const data=await res.json();
    if(data.ok&&data.intro){
      _markIntroStart=data.intro.start;
      _markIntroEnd=data.intro.end;
      updateMarkIntroDisplay();
      btn.textContent='Auto-detect';
      btn.disabled=false;
      console.log('[SkipIntro] Auto-detected:',data.intro.start+'s -',data.intro.end+'s');
    } else {
      btn.textContent='Auto-detect';
      btn.disabled=false;
      showToast(data.message||'Could not detect intro pattern','error');
    }
  }catch(e){
    btn.textContent='Auto-detect';
    btn.disabled=false;
    console.error('[SkipIntro] Auto-detect error:',e);
  }
}

function toggleMenu(id,e){e.stopPropagation();const m=document.getElementById(id);const o=m.classList.contains('open');closeMenus();if(!o)m.classList.add('open');}
function closeMenus(){document.querySelectorAll('.speed-menu,.skip-menu,.sub-menu,.audio-menu,.boost-menu,.quality-menu').forEach(m=>m.classList.remove('open'));}
document.addEventListener('click',e=>{if(!e.target.closest('.ctrl-btn-wrap'))closeMenus();});

async function togglePiP(){try{if(document.pictureInPictureElement)await document.exitPictureInPicture();else if(V.requestPictureInPicture)await V.requestPictureInPicture();}catch{}}
if(!document.pictureInPictureEnabled&&!V.requestPictureInPicture){const b=document.getElementById('pipBtn');if(b)b.style.display='none';}

async function playMedia(id){
  const item=library.find(m=>m.id===id);if(!item)return;
  ensureAudioBoostReady().catch(()=>{});
  // Fetch full item details (subtitles, audioTracks, etc.)
  try{
    const res=await fetch(`/api/item/${id}`);
    const full=await res.json();
    if(res.ok) Object.assign(item,full);
  }catch(e){console.error('[playMedia] item fetch error:', e.message);}
  currentMedia=item;
  document.getElementById('playerTitle').textContent=item.title;
  if(typeof _clearThumbCache==='function')_clearThumbCache();
  // Trigger sprite sheet generation in background
  if(typeof _loadSprites==='function')_loadSprites(id);

  // Restore saved volume
  const savedVol=parseFloat(localStorage.getItem('playerVolume'));
  if(!isNaN(savedVol)){V.volume=Math.max(0,Math.min(1,savedVol));V.muted=savedVol===0;}

  // Fully reset video element
  if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
  V.removeAttribute('src');
  V.load();
  _hasPlayedBefore=false;_lastStallRecovery=0;
  document.getElementById('progressBuffered').style.width='0%';

  const prog=item.progress||{};
  const startTime=(prog.percent||0)>=95?0:(prog.currentTime>5?prog.currentTime:0);
  modal.classList.add('active');

  // Direct streaming — only when server confirms direct play is safe (h264+aac in mp4)
  if(item.streamMode==='direct'){
    window._hlsSeekOffset=0;
    window._hlsTotalDur=0;
    window._hlsLoad=null;
    V.src='/stream/'+item.id;
    V.playbackRate=playbackSpeed;
    if(startTime>0){
      const _seekTimeout=setTimeout(()=>{V.currentTime=startTime;V.play().catch(()=>{});},5000);
      V.addEventListener('loadedmetadata',()=>{clearTimeout(_seekTimeout);V.currentTime=startTime;V.play().catch(()=>{});},{once:true});
    } else {
      V.play().catch(()=>{});
    }
    startProgressSync();showControls();resetUpNext();
    modal.addEventListener('mousemove',showControls);
    updateEpBtns();buildSubMenu();buildAudioMenu();
    loadSkipSegments(item.id);
    if(profileQueue.includes(item.id))removeFromQueue(item.id);
    return;
  }

  const qualityParam='&quality='+_currentQuality;
  const hlsUrl='/hls/'+item.id+'/master.m3u8?start='+startTime+qualityParam;

  if(typeof Hls!=='undefined'&&Hls.isSupported()){
    window._hlsSeekOffset=startTime;
    window._hlsTotalDur=0;
    window._hlsRetries=0;
    window._hlsLoadId=0;
    window._hlsLoad=function(url){
      if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
      V.removeAttribute('src');V.load();
      document.getElementById('progressBuffered').style.width='0%';
      window._hlsRetries=0;
      var loadId=++window._hlsLoadId;
      // Fetch manifest to get duration headers and start ffmpeg session
      fetch(url).then(r=>{
        if(loadId!==window._hlsLoadId)return; // stale seek, skip
        const totalDur=parseFloat(r.headers.get('X-Total-Duration'))||0;
        const seekOff=parseFloat(r.headers.get('X-Seek-Offset'))||0;
        if(totalDur>0) window._hlsTotalDur=totalDur;
        if(seekOff>=0) window._hlsSeekOffset=seekOff;
        if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
        hlsInstance=new Hls({
          maxBufferLength:30,maxMaxBufferLength:120,startFragPrefetch:true,
          // startPosition:0 + no liveSync* keys: treat the EVENT playlist as VOD
          // and start from the first segment. Previously liveSyncDuration:0 made
          // HLS.js jump to the live edge, starting at whatever segment ffmpeg
          // had produced — causing a stall while it stabilized.
          startPosition:0,
          highBufferWatchdogPeriod:2,nudgeOffset:0.2,nudgeMaxRetry:5,enableWorker:true,
          fragLoadingTimeOut:30000,fragLoadingMaxRetry:4,fragLoadingRetryDelay:1000,
          autoStartLoad:false,
        });
        hlsInstance.loadSource(url);
        hlsInstance.attachMedia(V);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED,function(){
          if(loadId!==window._hlsLoadId)return;
          V.playbackRate=playbackSpeed;
          function onCanPlayThrough(){
            V.removeEventListener('canplaythrough',onCanPlayThrough);
            V.play().catch(()=>{});
          }
          V.addEventListener('canplaythrough',onCanPlayThrough);
          hlsInstance.startLoad();
        });
        hlsInstance.on(Hls.Events.ERROR,(_e,data)=>{
          if(data.fatal){
            console.error('HLS fatal error:',data.type,data.details,data.reason);
            window._hlsRetries++;
            if(window._hlsRetries>3){console.error('HLS: giving up after 3 retries');return;}
            if(data.type===Hls.ErrorTypes.NETWORK_ERROR)hlsInstance.startLoad();
            else if(data.type===Hls.ErrorTypes.MEDIA_ERROR)hlsInstance.recoverMediaError();
          }
        });
        _hlsSeekPending=false;
      }).catch(err=>{console.error('Failed to load HLS:',err);_hlsSeekPending=false;});
    };
    window._hlsLoad(hlsUrl);
  } else if(V.canPlayType('application/vnd.apple.mpegurl')){
    // Safari native HLS
    V.src=hlsUrl;V.playbackRate=playbackSpeed;V.play().catch(()=>{});
  }

  startProgressSync();showControls();resetUpNext();
  modal.addEventListener('mousemove',showControls);
  updateEpBtns();buildSubMenu();buildAudioMenu();
  loadSkipSegments(id);
  if(profileQueue.includes(id))removeFromQueue(id);
}

async function closePlayer(){
  // Stop casting if active
  if(_castSession&&_castMedia){
    castStopProgressSync();
    try{await cast.framework.CastContext.getInstance().endCurrentSession(true);}catch{}
    _castSession=null;_castMedia=null;_castToken=null;
    castShowOverlay(false);
  }
  await saveProg();V.pause();resetUpNext();
  if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});
  if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
  V.removeAttribute('src');V.load();
  V.querySelectorAll('track').forEach(t=>t.remove());
  modal.classList.remove('active');currentMedia=null;
  _skipSegments=null;_skipSegmentDismissed={};_currentAudioTrack=null;_markIntroStart=null;_markIntroEnd=null;
  document.getElementById('skipIntroBox').classList.remove('visible','fade-out');
  document.getElementById('markIntroPanel').classList.remove('visible');
  document.getElementById('markIntroBtn').style.display='none';
  clearInterval(progressSaveInterval);modal.removeEventListener('mousemove',showControls);
  closeMenus();fetchLib();fetchQueue();
}

function togglePlay(e){if(e&&e.target.closest('.player-controls,.player-top-bar'))return;if(_castMedia&&_castSession){castTogglePlay();return;}V.paused?V.play():V.pause();}
function setVol(v){
  const next=Math.max(0,Math.min(1,Number(v)||0));
  V.volume=next;V.muted=next===0;
  localStorage.setItem('playerVolume',next);
  updateVolumeUI();syncAudioBoostGain();
}
function toggleMute(){V.muted=!V.muted;if(!V.muted)localStorage.setItem('playerVolume',V.volume);updateVolumeUI();syncAudioBoostGain();}
function toggleFS(){document.fullscreenElement?document.exitFullscreen().catch(()=>{}):modal.requestFullscreen().catch(()=>{});}

// Click vs double-click on video wrapper (manual detection for reliability)
let _clickCount=0,_clickTimer=null;
document.getElementById('videoWrapper').addEventListener('click',function(e){
  if(_isTouch)return;
  if(e.target.closest('.player-controls,.player-top-bar,.up-next-overlay,.skip-intro-box,.mark-intro-panel,.cast-overlay'))return;
  _clickCount++;
  if(_clickCount===1){
    _clickTimer=setTimeout(()=>{_clickCount=0;if(_castMedia&&_castSession){castTogglePlay();}else{V.paused?V.play():V.pause();}},300);
  } else if(_clickCount>=2){
    clearTimeout(_clickTimer);_clickCount=0;
    toggleFS();
  }
});

// Progress bar
let isSeeking=false;
let _hlsSeekPending=false;
progContainer.addEventListener('mousedown',e=>{isSeeking=true;seekVisual(e);});
document.addEventListener('mousemove',e=>{if(isSeeking)seekVisual(e);});
document.addEventListener('mouseup',()=>{if(isSeeking){isSeeking=false;seekCommit();}});
progContainer.addEventListener('touchstart',e=>{isSeeking=true;seekVisual(e.touches[0]);},{passive:true});
document.addEventListener('touchmove',e=>{if(isSeeking)seekVisual(e.touches[0]);},{passive:true});
document.addEventListener('touchend',()=>{if(isSeeking){isSeeking=false;seekCommit();}});

// YouTube-style sprite sheet seek preview
const seekPreview=document.getElementById('seekPreview');
const seekPreviewThumb=document.getElementById('seekPreviewThumb');
const seekPreviewTime=document.getElementById('seekPreviewTime');
let _spriteData=null, _spriteMediaId='', _spriteSheets={}, _lastSpriteT=-1;

function _clearThumbCache(){
  _spriteData=null;_spriteMediaId='';_spriteSheets={};_lastSpriteT=-1;
  seekPreviewThumb.style.backgroundImage='';
}

function _loadSprites(id){
  if(_spriteMediaId===id && _spriteData) return;
  _spriteMediaId=id;
  fetch('/api/sprites/'+id+'/generate',{method:'POST'}).then(r=>r.json()).then(data=>{
    if(_spriteMediaId!==id) return;
    _spriteData=data;
    // Preload all sprite sheets
    for(let s=0;s<data.totalSheets;s++){
      if(!_spriteSheets[id+'_'+s]){
        const img=new Image();
        const sheetUrl='/api/sprites/'+id+'/'+s;
        img.onload=function(){_spriteSheets[id+'_'+s]=sheetUrl;};
        img.src=sheetUrl;
      }
    }
    // If still generating, poll until done
    if(data.status!=='ready'){
      const poll=setInterval(()=>{
        if(_spriteMediaId!==id){clearInterval(poll);return;}
        fetch('/api/sprites/'+id+'/generate',{method:'POST'}).then(r=>r.json()).then(d=>{
          if(d.status==='ready'){
            clearInterval(poll);
            _spriteData=d;
            for(let s=0;s<d.totalSheets;s++){
              if(!_spriteSheets[id+'_'+s]){
                const img=new Image();
                const u='/api/sprites/'+id+'/'+s;
                img.onload=function(){_spriteSheets[id+'_'+s]=u;};
                img.src=u;
              }
            }
          }
        }).catch(()=>{});
      },3000);
    }
  }).catch(()=>{});
}

progContainer.addEventListener('mousemove',e=>{
  if(!currentMedia)return;
  if(_spriteMediaId!==currentMedia.id){_clearThumbCache();_loadSprites(currentMedia.id);}
  const r=progContainer.getBoundingClientRect();
  const p=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
  const t=p*_hlsTotalDuration();
  const roundedT=Math.floor(t/10)*10;
  const left=Math.max(85,Math.min(r.width-85,e.clientX-r.left));
  seekPreview.style.left=left+'px';
  seekPreview.classList.add('visible');
  seekPreviewTime.textContent=fmt(t);
  if(roundedT!==_lastSpriteT && _spriteData){
    _lastSpriteT=roundedT;
    const frameIndex=Math.floor(roundedT/_spriteData.interval);
    const sheetNum=Math.floor(frameIndex/(_spriteData.cols*_spriteData.rows));
    const posInSheet=frameIndex%(_spriteData.cols*_spriteData.rows);
    const col=posInSheet%_spriteData.cols;
    const row=Math.floor(posInSheet/_spriteData.cols);
    const sheetKey=currentMedia.id+'_'+sheetNum;
    if(_spriteSheets[sheetKey]){
      seekPreviewThumb.style.backgroundImage='url('+_spriteSheets[sheetKey]+')';
      seekPreviewThumb.style.backgroundSize=(_spriteData.cols*160)+'px '+(_spriteData.rows*90)+'px';
      seekPreviewThumb.style.backgroundPosition='-'+(col*160)+'px -'+(row*90)+'px';
    }
  }
});
progContainer.addEventListener('mouseleave',()=>{
  seekPreview.classList.remove('visible');
  _lastSpriteT=-1;
});

let _seekTarget=0;
function _hlsTotalDuration(){return window._hlsTotalDur||(window._hlsSeekOffset||0)+(V.duration||0);}
function seekVisual(e){
  const r=progContainer.getBoundingClientRect();
  const p=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
  _seekTarget=p*_hlsTotalDuration();
  document.getElementById('progressFilled').style.width=(p*100)+'%';
  document.getElementById('timeDisplay').textContent=fmt(_seekTarget)+' / '+fmt(_hlsTotalDuration());
}
function seekCommit(){
  if(!currentMedia)return;
  // Reset dismissed flags so skip buttons can reappear after seeking
  _skipSegmentDismissed={};
  // If casting, seek on Cast device
  if(_castMedia&&_castSession){castSeek(_seekTarget);return;}
  const isHls=currentMedia.streamMode&&currentMedia.streamMode!=='direct';
  if(isHls&&typeof window._hlsLoad==='function'){
    // For HLS: restart ffmpeg from seek position and reload stream
    window._hlsSeekOffset=_seekTarget;
    _hlsSeekPending=true;
    window._hlsLoad('/hls/'+currentMedia.id+'/master.m3u8?start='+_seekTarget+'&quality='+_currentQuality);
  } else {
    // Direct play: just set currentTime
    if(V.duration)V.currentTime=_seekTarget;
  }
}

// Up Next state
let _upNextShown=false, _upNextCancelled=false, _upNextCountdown=null;
const UP_NEXT_SHOW_AT=30; // show overlay 30s before end
const UP_NEXT_AUTO_AT=10; // start countdown 10s before end

function getNextEp(){
  const pl=getPlaylist(),i=getCurIdx();
  if(pl.length>1&&i>=0&&i<pl.length-1) return pl[i+1];
  return null;
}
function showUpNext(){
  const next=getNextEp();
  if(!next||_upNextShown||_upNextCancelled)return;
  _upNextShown=true;
  const epLabel=next.epInfo?`S${String(next.epInfo.season).padStart(2,'0')}E${String(next.epInfo.episode).padStart(2,'0')}`:'';
  document.getElementById('upNextTitle').textContent=next.showName||next.title;
  document.getElementById('upNextEp').textContent=epLabel?(epLabel+' — '+next.title):next.title;
  document.getElementById('upNextCountdown').textContent='';
  document.getElementById('upNextOverlay').classList.add('visible');
}
function hideUpNext(){
  document.getElementById('upNextOverlay').classList.remove('visible');
  _upNextShown=false;
  clearInterval(_upNextCountdown);_upNextCountdown=null;
}
function cancelUpNext(){_upNextCancelled=true;hideUpNext();}
function resetUpNext(){_upNextShown=false;_upNextCancelled=false;hideUpNext();}

V.addEventListener('timeupdate',()=>{
  if(!V.duration||isSeeking)return;
  const offset=window._hlsSeekOffset||0;
  const total=window._hlsTotalDur||(offset+V.duration);const cur=offset+V.currentTime;
  const p=(cur/total)*100;
  document.getElementById('progressFilled').style.width=p+'%';
  document.getElementById('timeDisplay').textContent=fmt(cur)+' / '+fmt(total);
  // Skip intro check
  checkSkipIntro();
  // Up Next: show overlay near end of episode
  const remaining=total-cur;
  if(remaining<=UP_NEXT_SHOW_AT&&remaining>0&&getNextEp()&&!_upNextCancelled){
    showUpNext();
    if(remaining<=UP_NEXT_AUTO_AT&&!_upNextCancelled){
      document.getElementById('upNextCountdown').textContent='Playing in '+Math.ceil(remaining)+'s...';
    }
  }
});
// Buffer bar: shows how far ahead the browser/HLS.js has buffered
V.addEventListener('progress',updateBufferBar);
V.addEventListener('timeupdate',updateBufferBar);
V.addEventListener('volumechange',()=>{updateVolumeUI();syncAudioBoostGain();});
function updateBufferBar(){
  if(!V.duration&&!window._hlsTotalDur)return;
  const offset=window._hlsSeekOffset||0;
  const total=window._hlsTotalDur||(offset+(V.duration||0));
  if(total<=0)return;
  let bufEnd=0;
  for(let i=0;i<V.buffered.length;i++){
    const end=offset+V.buffered.end(i);
    if(end>bufEnd)bufEnd=end;
  }
  const pct=Math.min(100,(bufEnd/total)*100);
  document.getElementById('progressBuffered').style.width=pct+'%';
}
V.addEventListener('play',()=>{document.getElementById('playPauseBtn').innerHTML='&#10074;&#10074;';});
V.addEventListener('pause',()=>{document.getElementById('playPauseBtn').innerHTML='&#9654;&#65039;';});

// Stall recovery: if paused too long, the backend session times out and buffer runs dry
let _stallTimer=null;
let _lastStallRecovery=0;
let _hasPlayedBefore=false;
V.addEventListener('waiting',()=>{
  if(!currentMedia||V.paused)return;
  // Don't trigger stall recovery during initial load — only after playback has started
  if(!_hasPlayedBefore)return;
  clearTimeout(_stallTimer);
  _stallTimer=setTimeout(()=>{
    if(V.paused||!currentMedia)return;
    if(Date.now()-_lastStallRecovery<15000)return;
    if(V.readyState<3&&typeof window._hlsLoad==='function'){
      console.log('[Stall Recovery] Buffer exhausted, reloading HLS from current position');
      _lastStallRecovery=Date.now();
      const currentTime=Math.round(V.currentTime+(window._hlsSeekOffset||0));
      const audioParam=_currentAudioTrack!=null?'&audio='+_currentAudioTrack:'';
      window._hlsSeekOffset=currentTime;
      window._hlsLoad('/hls/'+currentMedia.id+'/master.m3u8?start='+currentTime+audioParam+'&quality='+_currentQuality);
    }
  },5000);
});
V.addEventListener('playing',()=>{clearTimeout(_stallTimer);_hasPlayedBefore=true;});
V.addEventListener('ended',()=>{
  const next=getNextEp();
  if(next&&!_upNextCancelled){saveProg();playMedia(next.id);}
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&document.getElementById('mediaDetailOverlay')&&!modal.classList.contains('active')){
    e.preventDefault();
    closeMediaDetail();
    return;
  }
  if(!modal.classList.contains('active'))return;
  switch(e.key){
    case ' ':case 'k':e.preventDefault();togglePlay();break;
    case 'ArrowLeft':e.preventDefault();skipBack();break;case 'ArrowRight':e.preventDefault();skipFwd();break;
    case 'ArrowUp':e.preventDefault();setVol(Math.min(1,V.volume+.1));document.getElementById('volumeSlider').value=V.volume;break;
    case 'ArrowDown':e.preventDefault();setVol(Math.max(0,V.volume-.1));document.getElementById('volumeSlider').value=V.volume;break;
    case 'f':toggleFS();break;case 'm':toggleMute();break;case 'p':togglePiP();break;
    case 'n':case 'N':e.preventDefault();playNextEp();break;case 'b':case 'B':e.preventDefault();playPrevEp();break;
    case '>':e.preventDefault();setSpd(Math.min(2,playbackSpeed+.25));break;case '<':e.preventDefault();setSpd(Math.max(.25,playbackSpeed-.25));break;
    case 'c':setSub(V.textTracks.length>0&&V.textTracks[0].mode==='showing'?-1:0);break;
    case 'Escape':closePlayer();break;
  }
});

function showControls(){modal.classList.add('controls-visible');clearTimeout(controlsTimeout);controlsTimeout=setTimeout(()=>{modal.classList.remove('controls-visible');},3000);}

// When user presses Escape in fullscreen, the browser exits fullscreen (swallowing the
// keydown event). A second Escape press then closes the player via the keydown handler.

// Touch support: single tap toggles controls; double tap skips forward.
let _touchTapCount=0,_touchTapTimer=null;
document.getElementById('videoWrapper').addEventListener('click',function(e){
  if(!_isTouch)return; // desktop uses mousemove
  if(e.target.closest('.player-controls,.player-top-bar,.sub-menu,.audio-menu,.boost-menu,.speed-menu,.skip-menu,.quality-menu'))return;
  e.preventDefault();
  e.stopPropagation(); // prevent desktop play/fullscreen behavior on mobile
  _touchTapCount++;
  if(_touchTapCount===1){
    _touchTapTimer=setTimeout(()=>{
      _touchTapCount=0;
      if(modal.classList.contains('controls-visible')){
        modal.classList.remove('controls-visible');clearTimeout(controlsTimeout);
      } else {
        showControls();
      }
    },260);
    return;
  }
  clearTimeout(_touchTapTimer);
  _touchTapCount=0;
  skipFwd();
  showControls();
});

// Re-show controls on orientation change so user doesn't lose them
screen.orientation?.addEventListener('change',()=>{if(modal.classList.contains('active'))showControls();});
window.addEventListener('resize',()=>{if(_isTouch&&modal.classList.contains('active'))showControls();});

function startProgressSync(){clearInterval(progressSaveInterval);progressSaveInterval=setInterval(saveProg,5000);}
async function saveProg(){
  if(!currentMedia||!V.duration)return;
  const offset=window._hlsSeekOffset||0;
  const cur=offset+V.currentTime;
  const total=_hlsTotalDuration();
  try{await fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:currentMedia.id,currentTime:cur,duration:total,profile:activeProfile})});
  currentMedia.progress={currentTime:cur,duration:total,percent:Math.round((cur/total)*100),updatedAt:Date.now()};}catch{}
}

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════
function fmt(s){if(!s||isNaN(s))return '0:00';const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60);return h>0?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function escAttr(s){return s.replace(/&/g,'&amp;').replace(/'/g,'&#39;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\/g,'\\\\');}
function escCssUrl(s){return escAttr(String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\r?\n/g,''));}
function formatSize(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(1)+' GB';}
function showToast(message,type='info'){
  let stack=document.getElementById('toastStack');
  if(!stack){
    stack=document.createElement('div');
    stack.id='toastStack';
    stack.className='toast-stack';
    document.body.appendChild(stack);
  }
  const toast=document.createElement('div');
  toast.className='toast toast-'+type;
  toast.textContent=message;
  stack.appendChild(toast);
  requestAnimationFrame(()=>toast.classList.add('visible'));
  setTimeout(()=>{
    toast.classList.remove('visible');
    setTimeout(()=>toast.remove(),180);
  },3200);
}

// ══════════════════════════════════════════════════════════════════════
// Chromecast
// ══════════════════════════════════════════════════════════════════════
let _castSession=null,_castToken=null,_castMedia=null,_castProgressInterval=null;
let _castServerInfo=null; // { lanHost, port }

function castInit(){
  if(typeof cast==='undefined'||typeof chrome==='undefined'||!chrome.cast)return;
  const ctx=cast.framework.CastContext.getInstance();
  ctx.setOptions({
    receiverApplicationId:chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy:chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
  ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED,function(e){
    if(e.sessionState===cast.framework.SessionState.SESSION_STARTED||
       e.sessionState===cast.framework.SessionState.SESSION_RESUMED){
      _castSession=ctx.getCurrentSession();
    } else if(e.sessionState===cast.framework.SessionState.SESSION_ENDED){
      castOnDisconnect();
    }
  });
  // Show cast button when device available
  ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED,function(e){
    const btn=document.getElementById('castBtn');
    if(btn)btn.style.display=(e.castState!==cast.framework.CastState.NO_DEVICES_AVAILABLE)?'':'none';
  });
}

// Called by __onGCastApiAvailable (set up below)
window['__onGCastApiAvailable']=function(isAvailable){
  if(isAvailable)castInit();
};

async function castGetServerInfo(){
  if(_castServerInfo)return _castServerInfo;
  try{
    const r=await fetch('/api/server-info',{credentials:'same-origin'});
    _castServerInfo=await r.json();
  }catch{
    _castServerInfo={lanHost:location.hostname,port:location.port||80};
  }
  return _castServerInfo;
}

function castBuildBaseUrl(){
  const info=_castServerInfo;
  if(!info)return location.origin;
  // If we're already on a private IP, use current origin
  if(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(location.hostname))return location.origin;
  // Otherwise use LAN IP for Chromecast
  const proto=location.protocol;
  return `${proto}//${info.lanHost}:${info.port}`;
}

async function castGetToken(){
  try{
    const r=await fetch('/api/cast-token',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'}});
    const data=await r.json();
    _castToken=data.token;
    return _castToken;
  }catch(e){console.error('Failed to get cast token:',e);return null;}
}

async function castToggle(){
  const ctx=cast.framework.CastContext.getInstance();
  const session=ctx.getCurrentSession();
  if(session&&_castMedia){
    // Stop casting — resume locally
    castStopAndResume();
    return;
  }
  // Start casting
  try{
    await ctx.requestSession();
    _castSession=ctx.getCurrentSession();
    if(_castSession&&currentMedia)await castStartMedia();
  }catch(e){
    if(e!=='cancel')console.error('Cast session error:',e);
  }
}

async function castStartMedia(){
  if(!_castSession||!currentMedia)return;
  await castGetServerInfo();
  const token=await castGetToken();
  if(!token)return;

  const base=castBuildBaseUrl();
  const item=currentMedia;
  let contentType,url;

  if(item.streamMode==='direct'){
    url=`${base}/stream/${item.id}?cast_token=${token}`;
    contentType='video/mp4';
  } else {
    const offset=window._hlsSeekOffset||0;
    const q='&quality='+_currentQuality;
    url=`${base}/hls/${item.id}/master.m3u8?start=${offset}&cast_token=${token}${q}`;
    contentType='application/x-mpegURL';
  }

  const mediaInfo=new chrome.cast.media.MediaInfo(url,contentType);
  mediaInfo.metadata=new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title=item.title||'';
  if(item.episode)mediaInfo.metadata.subtitle=`S${item.season||1}E${item.episode}`;

  // Start from current position
  const request=new chrome.cast.media.LoadRequest(mediaInfo);
  const offset=window._hlsSeekOffset||0;
  const localPos=offset+V.currentTime;
  if(item.streamMode==='direct'&&localPos>0)request.currentTime=localPos;

  try{
    await _castSession.loadMedia(request);
    _castMedia=_castSession.getMediaSession();
    // Pause local, show overlay
    V.pause();
    if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
    castShowOverlay(true);
    castStartProgressSync();
    // Listen for Cast media status changes (for error/end detection)
    _castMedia.addUpdateListener(castOnMediaUpdate);
  }catch(e){
    console.error('Cast loadMedia failed:',e);
    // If direct play failed, retry with HLS (transcode fallback)
    if(item.streamMode==='direct'){
      console.log('Cast: direct play failed, falling back to HLS transcode');
      const hlsUrl=`${base}/hls/${item.id}/master.m3u8?start=0&cast_token=${token}&quality=${_currentQuality}`;
      const hlsInfo=new chrome.cast.media.MediaInfo(hlsUrl,'application/x-mpegURL');
      hlsInfo.metadata=mediaInfo.metadata;
      const hlsReq=new chrome.cast.media.LoadRequest(hlsInfo);
      try{
        await _castSession.loadMedia(hlsReq);
        _castMedia=_castSession.getMediaSession();
        V.pause();
        castShowOverlay(true);
        castStartProgressSync();
        _castMedia.addUpdateListener(castOnMediaUpdate);
      }catch(e2){
        console.error('Cast HLS fallback also failed:',e2);
        showToast('Failed to cast this media');
      }
    } else {
      showToast('Failed to cast this media');
    }
  }
}

function castOnMediaUpdate(isAlive){
  if(!isAlive||!_castMedia)return;
  // Update local seek bar from Cast position
  const dur=_castMedia.media?.duration||0;
  const cur=_castMedia.getEstimatedTime?_castMedia.getEstimatedTime():_castMedia.currentTime||0;
  if(dur>0){
    document.getElementById('progressFilled').style.width=((cur/dur)*100)+'%';
    document.getElementById('timeDisplay').textContent=fmt(cur)+' / '+fmt(dur);
  }
}

function castShowOverlay(show){
  const overlay=document.getElementById('castOverlay');
  const wrapper=document.getElementById('videoWrapper');
  if(show){
    overlay.classList.add('active');
    wrapper.style.opacity='0';
    document.getElementById('castOverlayTitle').textContent=currentMedia?.title||'';
    const deviceName=_castSession?.getCastDevice?.()?.friendlyName||'Chromecast';
    document.getElementById('castOverlayDevice').textContent='Casting to '+deviceName;
    // Hide controls not relevant during cast
    document.getElementById('pipBtn').style.display='none';
    document.getElementById('markIntroBtn').style.display='none';
    document.getElementById('skipIntroBox').classList.remove('visible');
    document.getElementById('castBtn').textContent='\u23F9'; // stop icon
    document.getElementById('castBtn').title='Stop Casting';
  } else {
    overlay.classList.remove('active');
    wrapper.style.opacity='';
    document.getElementById('pipBtn').style.display='';
    document.getElementById('castBtn').textContent='\uD83D\uDCE1'; // antenna icon
    document.getElementById('castBtn').title='Cast';
  }
}

function castStartProgressSync(){
  clearInterval(_castProgressInterval);
  _castProgressInterval=setInterval(async()=>{
    if(!_castMedia||!currentMedia)return;
    const dur=_castMedia.media?.duration||0;
    const cur=_castMedia.getEstimatedTime?_castMedia.getEstimatedTime():_castMedia.currentTime||0;
    if(dur>0&&cur>0){
      try{await fetch('/api/progress',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:currentMedia.id,currentTime:cur,duration:dur,profile:activeProfile})});
      currentMedia.progress={currentTime:cur,duration:dur,percent:Math.round((cur/dur)*100),updatedAt:Date.now()};}catch{}
    }
  },10000);
}

function castStopProgressSync(){
  clearInterval(_castProgressInterval);
  _castProgressInterval=null;
}

async function castStopAndResume(){
  // Get current Cast position before stopping
  let resumeTime=0;
  if(_castMedia){
    resumeTime=_castMedia.getEstimatedTime?_castMedia.getEstimatedTime():_castMedia.currentTime||0;
  }
  castStopProgressSync();
  // Stop cast session
  const ctx=cast.framework.CastContext.getInstance();
  try{await ctx.endCurrentSession(true);}catch{}
  _castSession=null;_castMedia=null;_castToken=null;
  castShowOverlay(false);
  // Resume locally from Cast position
  if(currentMedia&&resumeTime>0){
    if(currentMedia.streamMode==='direct'){
      V.src='/stream/'+currentMedia.id;
      V.currentTime=resumeTime;
      V.play().catch(()=>{});
    } else {
      // Re-initiate HLS from cast position
      if(window._hlsLoad){
        window._hlsSeekOffset=resumeTime;
        const url='/hls/'+currentMedia.id+'/master.m3u8?start='+resumeTime+'&quality='+_currentQuality;
        window._hlsLoad(url);
      }
    }
    startProgressSync();
  }
}

function castOnDisconnect(){
  if(!_castMedia&&!_castSession)return;
  castStopProgressSync();
  _castSession=null;_castMedia=null;_castToken=null;
  castShowOverlay(false);
  showToast('Cast disconnected');
  // Resume locally if player is still open
  if(currentMedia&&modal.classList.contains('active')){
    const prog=currentMedia.progress;
    if(prog&&prog.currentTime>0){
      if(currentMedia.streamMode==='direct'){
        V.src='/stream/'+currentMedia.id;
        V.currentTime=prog.currentTime;
        V.play().catch(()=>{});
      } else if(window._hlsLoad){
        window._hlsSeekOffset=prog.currentTime;
        window._hlsLoad('/hls/'+currentMedia.id+'/master.m3u8?start='+prog.currentTime+'&quality='+_currentQuality);
      }
      startProgressSync();
    }
  }
}

// Cast play/pause controls — override togglePlay when casting
const _origTogglePlay=typeof togglePlay==='function'?togglePlay:null;
function castTogglePlay(){
  if(_castMedia&&_castSession){
    const ctrl=new chrome.cast.media.PlayOrPauseRequest();
    if(_castMedia.playerState===chrome.cast.media.PlayerState.PLAYING){
      _castMedia.pause(null,()=>{},()=>{});
    } else {
      _castMedia.play(null,()=>{},()=>{});
    }
    return;
  }
}

function castSeek(time){
  if(!_castMedia)return;
  const req=new chrome.cast.media.SeekRequest();
  req.currentTime=time;
  _castMedia.seek(req,()=>{},()=>{});
}

// ══════════════════════════════════════════════════════════════════════
// Downloads (qBittorrent)
// ══════════════════════════════════════════════════════════════════════
let dlSearchId=null,dlSearchResults=[],dlSearching=false,dlTorrents=[],dlRefreshInterval=null,dlActiveTab='search',orgLogLines=[],orgLogFilter='all';
let dlSortField='nbSeeders',dlSortAsc=false,dlPlugins=[];

function dlStatusClass(state){
  if(state==='downloading'||state==='metaDL'||state==='forcedDL')return 'downloading';
  if(state==='pausedDL'||state==='pausedUP'||state==='stoppedDL'||state==='stoppedUP')return 'paused';
  if(state==='uploading'||state==='forcedUP')return 'seeding';
  if(state==='stalledDL'||state==='stalledUP')return 'stalled';
  if(state==='error'||state==='missingFiles')return 'error';
  if(state==='checkingDL'||state==='checkingUP'||state==='checkingResumeData')return 'stalled';
  return 'completed';
}
function dlStatusLabel(state){
  const map={downloading:'Downloading',metaDL:'Getting metadata',forcedDL:'Downloading',pausedDL:'Paused',pausedUP:'Paused',stoppedDL:'Stopped',stoppedUP:'Stopped',uploading:'Seeding',forcedUP:'Seeding',stalledDL:'Stalled',stalledUP:'Seeding',error:'Error',missingFiles:'Missing files',checkingDL:'Checking',checkingUP:'Checking',checkingResumeData:'Checking'};
  return map[state]||'Complete';
}
function dlFormatSpeed(bps){if(bps<=0)return '';if(bps<1024)return bps+' B/s';if(bps<1048576)return(bps/1024).toFixed(1)+' KB/s';return(bps/1048576).toFixed(1)+' MB/s';}
function dlFormatEta(s){if(s<=0||s>=8640000)return '';const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;return(h?h+'h ':'')+(m?m+'m ':'')+(sec&&!h?sec+'s':'');}

async function renderLogs(){
  const a=document.getElementById('contentArea');
  a.innerHTML=`<div class="dl-page">
    <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:4px">Logs</h2>
    <p style="color:var(--text-muted);font-size:.82rem;margin-bottom:16px">Activity across all profiles</p>
    <div class="dl-tabs" style="margin-bottom:16px">
      <button class="filter-btn active" id="logsTabNow" onclick="logsTab('now',this)">Now Watching</button>
      <button class="filter-btn" id="logsTabHistory" onclick="logsTab('history',this)">Watch History</button>
      <button class="filter-btn" id="logsTabLogins" onclick="logsTab('logins',this)">Login Logs</button>
      <button class="filter-btn" id="logsTabStreams" onclick="logsTab('streams',this)">Streams</button>
      <button class="filter-btn" id="logsTabScans" onclick="logsTab('scans',this)">Scans</button>
      <button class="filter-btn" id="logsTabErrors" onclick="logsTab('errors',this)">Errors</button>
    </div>
    <div id="logsContent"><div style="text-align:center;padding:60px;color:var(--text-muted)">Loading...</div></div>
  </div>`;
  _logsCurrentTab='now';
  await logsRenderTab('now');
  clearInterval(window._logsInterval);
  window._logsInterval=setInterval(async()=>{
    if(currentView!=='logs'){clearInterval(window._logsInterval);return;}
    if(_logsCurrentTab==='now')await logsRenderTab('now');
  },5000);
}

let _logsCurrentTab='now';
let _logsCache=[];
let _logsFilterUser='all';
let _logsFilterStatus='all';
let _logsSearch='';

async function logsTab(tab,btn){
  document.querySelectorAll('#logsTabNow,#logsTabHistory,#logsTabLogins,#logsTabStreams,#logsTabScans,#logsTabErrors').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  _logsCurrentTab=tab;
  await logsRenderTab(tab);
}

function logsApplyFilters(){
  let data=_logsCache;
  if(_logsFilterUser!=='all') data=data.filter(e=>e.profileId===_logsFilterUser);
  if(_logsFilterStatus==='watched') data=data.filter(e=>e.watched);
  if(_logsFilterStatus==='inprogress') data=data.filter(e=>!e.watched&&e.percent>0&&e.percent<95);
  if(_logsSearch) data=data.filter(e=>e.title.toLowerCase().includes(_logsSearch)||e.profileName.toLowerCase().includes(_logsSearch));
  const el=document.getElementById('logsResults');
  if(!el)return;
  if(data.length===0){el.innerHTML=`<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:.9rem">No results.</div>`;return;}
  el.innerHTML=data.map(e=>{
    const d=new Date(e.timestamp);
    const dateStr=d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const pct=e.percent||0;
    const watchedBadge=e.watched
      ?`<span style="font-size:.68rem;padding:2px 7px;border-radius:99px;background:rgba(80,200,120,.15);color:#50c878;white-space:nowrap">Watched</span>`
      :(pct>0?`<span style="font-size:.68rem;padding:2px 7px;border-radius:99px;background:rgba(255,255,255,.08);color:var(--text-muted);white-space:nowrap">${pct}%</span>`:'');
    return `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-card);border-radius:8px">
      <div style="width:32px;height:32px;border-radius:50%;background:var(--accent-glow);display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:700;color:var(--accent);flex-shrink:0">${e.profileName.charAt(0).toUpperCase()}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.title}</div>
        <div style="font-size:.75rem;color:var(--text-muted);margin-top:1px">${e.profileName} &bull; ${dateStr}</div>
      </div>
      ${watchedBadge}
    </div>`;
  }).join('');
}

async function logsRenderTab(tab){
  const el=document.getElementById('logsContent');
  if(!el)return;
  if(tab==='now'){
    let viewers=[];
    try{const r=await fetch('/api/now-watching',{credentials:'same-origin'});if(r.ok)viewers=await r.json();}catch{}
    if(viewers.length===0){
      el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:.9rem">Nobody is watching anything right now.</div>`;
      return;
    }
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:10px">${viewers.map(v=>{
      const pct=v.duration?Math.round(v.currentTime/v.duration*100):0;
      const cur=Math.floor(v.currentTime/60)+':'+String(Math.floor(v.currentTime%60)).padStart(2,'0');
      const dur=Math.floor(v.duration/60)+':'+String(Math.floor(v.duration%60)).padStart(2,'0');
      return `<div style="display:flex;align-items:center;gap:14px;padding:14px;background:var(--bg-card);border-radius:10px">
        <div style="width:38px;height:38px;border-radius:50%;background:var(--accent-glow);display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:700;color:var(--accent);flex-shrink:0">${v.profileName.charAt(0).toUpperCase()}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.title}</div>
          <div style="font-size:.78rem;color:var(--text-muted);margin-top:2px">${v.profileName} &bull; ${cur} / ${dur} (${pct}%)</div>
          <div style="margin-top:6px;height:3px;background:rgba(255,255,255,.1);border-radius:2px"><div style="height:3px;background:var(--accent);border-radius:2px;width:${pct}%"></div></div>
        </div>
        <span style="font-size:.7rem;padding:3px 8px;border-radius:99px;background:rgba(var(--accent-rgb),.15);color:var(--accent);white-space:nowrap">LIVE</span>
      </div>`;
    }).join('')}</div>`;
  } else if(tab==='history'){
    try{const r=await fetch('/api/admin/logs',{credentials:'same-origin'});if(r.ok)_logsCache=await r.json();}catch{}
    if(_logsCache.length===0){
      el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:.9rem">No watch history yet.</div>`;
      return;
    }
    // Build unique user list for filter
    const users=[...new Map(_logsCache.map(e=>[e.profileId,e.profileName])).entries()];
    const userOpts=`<option value="all">All Users</option>`+users.map(([id,name])=>`<option value="${id}"${_logsFilterUser===id?' selected':''}>${name}</option>`).join('');
    el.innerHTML=`
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        <input class="form-input" type="text" placeholder="Search title or user..." value="${_logsSearch}" oninput="_logsSearch=this.value.toLowerCase();logsApplyFilters()" style="flex:1;min-width:160px;max-width:280px;padding:6px 10px;font-size:.82rem">
        <select class="sort-select" onchange="_logsFilterUser=this.value;logsApplyFilters()">${userOpts}</select>
        <select class="sort-select" onchange="_logsFilterStatus=this.value;logsApplyFilters()">
          <option value="all"${_logsFilterStatus==='all'?' selected':''}>All Status</option>
          <option value="watched"${_logsFilterStatus==='watched'?' selected':''}>Watched</option>
          <option value="inprogress"${_logsFilterStatus==='inprogress'?' selected':''}>In Progress</option>
        </select>
        <span style="font-size:.78rem;color:var(--text-muted)">${_logsCache.length} entries</span>
      </div>
      <div id="logsResults" style="display:flex;flex-direction:column;gap:6px"></div>`;
    logsApplyFilters();
  } else if(tab==='logins'){
    // Login Logs tab
    let loginLogs=[];
    try{const r=await fetch('/api/admin/login-logs',{credentials:'same-origin'});if(r.ok)loginLogs=await r.json();}catch{}
    if(loginLogs.length===0){
      el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:.9rem">No login attempts recorded yet.</div>`;
      return;
    }
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:6px">${loginLogs.map(e=>{
      const d=new Date(e.timestamp);
      const dateStr=d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const badge=e.success
        ?`<span style="font-size:.68rem;padding:2px 8px;border-radius:99px;background:rgba(80,200,120,.15);color:#50c878;white-space:nowrap">Success</span>`
        :`<span style="font-size:.68rem;padding:2px 8px;border-radius:99px;background:rgba(220,80,80,.15);color:#e05252;white-space:nowrap">${e.reason||'Failed'}</span>`;
      const label=e.profileName||e.username||'Unknown';
      const initials=label.charAt(0).toUpperCase();
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-card);border-radius:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:${e.success?'var(--accent-glow)':'rgba(220,80,80,.15)'};display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:700;color:${e.success?'var(--accent)':'#e05252'};flex-shrink:0">${initials}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.9rem">${label}</div>
          <div style="font-size:.75rem;color:var(--text-muted);margin-top:1px">${e.ip||''} &bull; ${dateStr}</div>
        </div>
        ${badge}
      </div>`;
    }).join('')}</div>`;
  } else if(tab==='streams'){
    let logs=[];
    try{const r=await fetch('/api/admin/stream-logs',{credentials:'same-origin'});if(r.ok)logs=await r.json();}catch{}
    if(logs.length===0){el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:.9rem">No stream sessions recorded yet.</div>`;return;}
    const modeColor={direct:'#50c878',remux:'#7eb8f7',transcode:'#f7b731'};
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:6px">${logs.map(e=>{
      const d=new Date(e.timestamp);
      const dateStr=d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      const col=modeColor[e.mode]||'var(--text-muted)';
      const modeBadge=`<span style="font-size:.68rem;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.07);color:${col};white-space:nowrap;text-transform:uppercase">${e.mode}</span>`;
      const seek=e.seekTime>0?` @ ${Math.floor(e.seekTime/60)}:${String(Math.floor(e.seekTime%60)).padStart(2,'0')}`:' @ start';
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-card);border-radius:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:var(--accent-glow);display:flex;align-items:center;justify-content:center;font-size:.85rem;flex-shrink:0">&#9654;</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.title}</div>
          <div style="font-size:.75rem;color:var(--text-muted);margin-top:1px">${e.profileName||'Unknown'} &bull; ${e.codec||'?'} &bull; q:${e.quality}${seek} &bull; ${dateStr}</div>
        </div>
        ${modeBadge}
      </div>`;
    }).join('')}</div>`;
  } else if(tab==='scans'){
    let logs=[];
    try{const r=await fetch('/api/admin/scan-logs',{credentials:'same-origin'});if(r.ok)logs=await r.json();}catch{}
    if(logs.length===0){el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:.9rem">No scans recorded yet.</div>`;return;}
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:6px">${logs.map(e=>{
      const d=new Date(e.timestamp);
      const dateStr=d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const dur=e.durationMs<1000?e.durationMs+'ms':(e.durationMs/1000).toFixed(1)+'s';
      const triggerLabel={startup:'Startup',invalidate:'Config change','file-watcher':'File change',manual:'Manual'}[e.trigger]||e.trigger;
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-card);border-radius:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.07);display:flex;align-items:center;justify-content:center;font-size:.85rem;flex-shrink:0">&#128269;</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:.9rem">${e.count.toLocaleString()} files &bull; ${dur}</div>
          <div style="font-size:.75rem;color:var(--text-muted);margin-top:1px">${triggerLabel} &bull; ${dateStr}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  } else if(tab==='errors'){
    let logs=[];
    try{const r=await fetch('/api/admin/error-logs',{credentials:'same-origin'});if(r.ok)logs=await r.json();}catch{}
    if(logs.length===0){el.innerHTML=`<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:.9rem">No errors recorded. <span style="color:#50c878">&#10003;</span></div>`;return;}
    el.innerHTML=`<div style="display:flex;flex-direction:column;gap:6px">${logs.map(e=>{
      const d=new Date(e.timestamp);
      const dateStr=d.toLocaleDateString()+' '+d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      return `<div style="display:flex;align-items:flex-start;gap:12px;padding:12px 14px;background:var(--bg-card);border-radius:8px">
        <div style="width:32px;height:32px;border-radius:50%;background:rgba(220,80,80,.15);display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0;margin-top:1px">&#9888;</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:.72rem;color:var(--text-muted);margin-bottom:3px">${e.context} &bull; ${dateStr}</div>
          <div style="font-size:.85rem;color:#e05252;word-break:break-all;font-family:monospace">${e.message}</div>
        </div>
      </div>`;
    }).join('')}</div>`;
  }
}

async function renderDownloads(){
  const a=document.getElementById('contentArea');
  a.innerHTML=`<div class="dl-page"><h2 style="font-size:1.3rem;font-weight:700;margin-bottom:4px">Downloads</h2><p style="color:var(--text-muted);font-size:.82rem;margin-bottom:12px">Search and download torrents via qBittorrent</p><div id="dlContent"><div style="text-align:center;padding:60px"><span class="dl-spinner" style="width:32px;height:32px;border-width:3px"></span><p style="color:var(--text-muted);margin-top:16px;font-size:.85rem">Connecting to qBittorrent...</p></div></div></div>`;
  if(dlActiveTab==='logs')dlActiveTab='search';
  // Check if qBT is configured and reachable
  try{
    const r=await fetch('/api/qbt/status');
    const d=await r.json();
    if(r.status===503){
      document.getElementById('dlContent').innerHTML=`<div style="text-align:center;padding:60px"><p style="color:var(--text-muted);font-size:.95rem">${d.error||'qBittorrent not configured.'}</p><p style="color:var(--text-muted);font-size:.82rem;margin-top:8px">Set QBT_USER, QBT_PASS, and QBT_URL environment variables to enable downloads.</p></div>`;
      return;
    }
    if(!d.connected){
      document.getElementById('dlContent').innerHTML=`<div style="text-align:center;padding:60px"><p style="color:var(--text-muted);font-size:.95rem">Could not connect to qBittorrent.</p><p style="color:var(--text-muted);font-size:.82rem;margin-top:8px">Make sure qBittorrent is running and the Web UI is enabled.</p></div>`;
      return;
    }
  }catch{
    document.getElementById('dlContent').innerHTML=`<div style="text-align:center;padding:60px"><p style="color:var(--text-muted);font-size:.95rem">Could not reach the server.</p></div>`;
    return;
  }
  Promise.all([dlFetchPlugins(),dlRefreshTorrents()]).then(()=>{
    if(currentView!=='downloads')return;
    const a2=document.getElementById('dlContent');
    if(!a2)return;
    const tabs=`<div class="dl-tabs"><button class="filter-btn ${dlActiveTab==='search'?'active':''}" onclick="dlSwitchTab('search')">Search</button><button class="filter-btn ${dlActiveTab==='active'?'active':''}" onclick="dlSwitchTab('active')">Active Downloads <span id="dlCount">(${dlTorrents.length})</span></button></div>`;
    a2.innerHTML=tabs+'<div id="dlTabContent"></div>';
    if(dlActiveTab==='search')renderDlSearch();
    else renderDlActive();
    startDlRefresh();
  });
}

function dlSortArrow(field){
  if(dlSortField!==field)return '';
  return `<span class="dl-sort-arrow">${dlSortAsc?'&#9650;':'&#9660;'}</span>`;
}
function dlSetSort(field){
  if(dlSortField===field)dlSortAsc=!dlSortAsc;
  else{dlSortField=field;dlSortAsc=false;}
  renderDlSearch();
}
function dlSortedResults(){
  return[...dlSearchResults].sort((a,b)=>{
    const va=a[dlSortField]||0,vb=b[dlSortField]||0;
    if(typeof va==='string')return dlSortAsc?va.localeCompare(vb):vb.localeCompare(va);
    return dlSortAsc?va-vb:vb-va;
  });
}
async function dlFetchPlugins(){
  if(dlPlugins.length>0)return;
  try{const r=await fetch('/api/qbt/search/plugins');dlPlugins=await r.json();}catch{dlPlugins=[];}
}
function renderDlSearch(){
  const c=document.getElementById('dlTabContent')||document.getElementById('dlContent');
  if(!c)return;
  // Only build search bar if it doesn't exist yet (prevents dropdown reset during polling)
  if(!document.getElementById('dlSearchInput')||!document.getElementById('dlResultsArea')){
    const tpb=dlPlugins.find(p=>/pirate/i.test(p.name)||/pirate/i.test(p.fullName));
    const defaultPlugin=tpb?tpb.name:'all';
    const pluginOpts=dlPlugins.map(p=>`<option value="${esc(p.name)}"${p.name===defaultPlugin?' selected':''}>${esc(p.fullName)}</option>`).join('');
    const searchHtml=`<div class="dl-search-bar"><input type="text" id="dlSearchInput" placeholder="Search torrents..." onkeydown="if(event.key==='Enter')dlStartSearch()"><select id="dlCategorySelect"><option value="all">All</option><option value="movies">Movies</option><option value="tv">TV Shows</option><option value="music">Music</option><option value="anime">Anime</option><option value="software">Software</option><option value="games">Games</option></select><select id="dlPluginSelect"><option value="all">All Plugins</option>${pluginOpts}</select><button class="btn btn-primary" id="dlSearchBtn" onclick="dlStartSearch()">Search</button><button class="btn btn-sm" onclick="dlClearSearch()" style="font-size:.78rem;padding:7px 10px">Clear</button></div><div id="dlResultsArea"></div>`;
    c.innerHTML=searchHtml;
  }
  // Update plugin dropdown if plugins loaded after initial render
  const ps=document.getElementById('dlPluginSelect');
  if(ps&&ps.options.length<=1&&dlPlugins.length>0){
    const tpb2=dlPlugins.find(p=>/pirate/i.test(p.name)||/pirate/i.test(p.fullName));
    const defPlugin=tpb2?tpb2.name:'all';
    ps.innerHTML='<option value="all">All Plugins</option>'+dlPlugins.map(p=>`<option value="${esc(p.name)}"${p.name===defPlugin?' selected':''}>${esc(p.fullName)}</option>`).join('');
  }
  // Update search button state
  const btn=document.getElementById('dlSearchBtn');
  if(btn){btn.disabled=dlSearching;btn.innerHTML=dlSearching?'<span class="dl-spinner"></span> Searching...':'Search';}
  // Update results area only
  const ra=document.getElementById('dlResultsArea');
  if(!ra)return;
  let resultsHtml='';
  if(dlSearchResults.length>0){
    const sorted=dlSortedResults();
    const header=`<div class="dl-header-row"><div class="dl-result-name dl-sortable ${dlSortField==='fileName'?'active':''}" onclick="dlSetSort('fileName')">Name ${dlSortArrow('fileName')}</div><div class="dl-result-site">Source</div><div class="dl-result-size dl-sortable ${dlSortField==='fileSize'?'active':''}" onclick="dlSetSort('fileSize')">Size ${dlSortArrow('fileSize')}</div><div class="dl-result-seeds dl-sortable ${dlSortField==='nbSeeders'?'active':''}" onclick="dlSetSort('nbSeeders')">Seeds ${dlSortArrow('nbSeeders')}</div><div class="dl-result-leeches dl-sortable ${dlSortField==='nbLeechers'?'active':''}" onclick="dlSetSort('nbLeechers')">Leeches ${dlSortArrow('nbLeechers')}</div><div style="min-width:52px"></div></div>`;
    resultsHtml=`<div class="dl-section"><div class="dl-section-title">${dlSearchResults.length} Results</div>${header}`;
    resultsHtml+=sorted.map(r=>{
      const seeds=r.nbSeeders||0,leeches=r.nbLeechers||0;
      return `<div class="dl-result-row"><div class="dl-result-name" title="${esc(r.fileName)}">${esc(r.fileName)}</div><div class="dl-result-site">${esc(r.siteUrl||'')}</div><div class="dl-result-size">${formatSize(r.fileSize||0)}</div><div class="dl-result-seeds ${seeds===0?'dl-seed-zero':''}">${seeds} S</div><div class="dl-result-leeches">${leeches} L</div><button class="btn btn-primary btn-sm" onclick="dlAddTorrent('${escAttr(r.fileUrl)}',this)" style="font-size:.72rem;padding:4px 10px">Add</button></div>`;
    }).join('');
    resultsHtml+='</div>';
  }else if(!dlSearching&&dlSearchId!==null){
    resultsHtml='<div class="dl-empty">No results found</div>';
  }
  ra.innerHTML=resultsHtml;
}

async function dlStartSearch(){
  const input=document.getElementById('dlSearchInput');
  const q=input?input.value.trim():'';
  if(!q)return;
  const cat=document.getElementById('dlCategorySelect').value;
  const plugin=document.getElementById('dlPluginSelect').value;
  dlSearching=true;dlSearchResults=[];dlSearchId=null;
  renderDlSearch();
  try{
    const r=await fetch('/api/qbt/search/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pattern:q,category:cat,plugins:plugin})});
    const j=await r.json();
    dlSearchId=j.id;
    let polls=0;
    const poll=async()=>{
      if(polls++>20||!dlSearching){try{await fetch('/api/qbt/search/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:dlSearchId})});}catch{}dlSearching=false;renderDlSearch();return;}
      try{
        const rr=await fetch(`/api/qbt/search/results?id=${dlSearchId}&limit=100`);
        const data=await rr.json();
        dlSearchResults=data.results||[];
        renderDlSearch();
        if(data.status==='Stopped'){dlSearching=false;renderDlSearch();return;}
      }catch{}
      setTimeout(poll,1500);
    };
    setTimeout(poll,2000);
  }catch(e){dlSearching=false;renderDlSearch();}
  // Restore search value
  const newInput=document.getElementById('dlSearchInput');
  if(newInput)newInput.value=q;
}

async function dlAddTorrent(url,btn){
  if(btn){btn.textContent='Adding...';btn.disabled=true;}
  try{
    await fetch('/api/qbt/torrents/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({urls:url})});
    if(btn){btn.textContent='Added';btn.style.background='#4caf50';}
  }catch{if(btn){btn.textContent='Error';btn.style.background='#f44336';}}
}

function renderDlActive(){
  const c=document.getElementById('dlTabContent')||document.getElementById('dlContent');
  if(!c)return;
  const countEl=document.getElementById('dlCount');
  if(countEl)countEl.textContent=dlTorrents.length?`(${dlTorrents.length})`:'';
  if(dlTorrents.length===0){c.innerHTML='<div class="dl-empty">No active downloads</div>';return;}
  c.innerHTML=`<div class="dl-section">${dlTorrents.map(t=>{
    const pct=Math.round(t.progress*100);
    const sc=dlStatusClass(t.state);
    const isPaused=sc==='paused';
    const dl=dlFormatSpeed(t.dlspeed);
    const ul=dlFormatSpeed(t.upspeed);
    const eta=dlFormatEta(t.eta);
    return `<div class="dl-torrent"><div class="dl-torrent-top"><div class="dl-torrent-name" title="${esc(t.name)}">${esc(t.name)}</div><span class="dl-torrent-status dl-status-${sc}">${dlStatusLabel(t.state)}</span><div class="dl-torrent-actions"><button class="btn btn-sm" onclick="dl${isPaused?'Resume':'Pause'}Torrent('${t.hash}')" style="font-size:.7rem;padding:3px 8px">${isPaused?'&#9654; Resume':'&#10074;&#10074; Pause'}</button><button class="btn btn-sm btn-danger" onclick="dlDeleteTorrent('${t.hash}','${escAttr(t.name)}')" style="font-size:.7rem;padding:3px 8px">&#128465; Delete</button></div></div><div class="dl-progress"><div class="dl-progress-fill ${pct>=100?'complete':''}" style="width:${pct}%"></div></div><div class="dl-torrent-meta"><span>${pct}%</span>${dl?`<span>&#8595; ${dl}</span>`:''}${ul?`<span>&#8593; ${ul}</span>`:''}${eta?`<span>ETA: ${eta}</span>`:''}${t.size?`<span>${formatSize(t.size)}</span>`:''}</div></div>`;
  }).join('')}</div>`;
}

async function dlRefreshTorrents(){
  try{const r=await fetch('/api/qbt/torrents');dlTorrents=await r.json();}catch{dlTorrents=[];}
}

function startDlRefresh(){
  if(dlRefreshInterval)clearInterval(dlRefreshInterval);
  dlRefreshInterval=setInterval(async()=>{
    if(currentView!=='downloads'){clearInterval(dlRefreshInterval);dlRefreshInterval=null;return;}
    if(dlActiveTab==='active'){await dlRefreshTorrents();renderDlActive();}
  },3000);
}

function dlClearSearch(){
  dlSearchResults=[];dlSearchId=null;dlSearching=false;
  const input=document.getElementById('dlSearchInput');
  if(input)input.value='';
  const ra=document.getElementById('dlResultsArea');
  if(ra)ra.innerHTML='';
  const btn=document.getElementById('dlSearchBtn');
  if(btn){btn.disabled=false;btn.textContent='Search';}
}
function dlSwitchTab(tab){dlActiveTab=tab;renderDownloads();}

async function dockerAction(action,container){
  const section=document.getElementById('dockerSection');
  if(section)section.style.opacity='0.5';
  try{await adminFetch('/api/docker/'+action+'/'+container,{method:'POST'});}catch{}
  // Wait for container to settle then re-render settings
  await new Promise(r=>setTimeout(r,2000));
  renderSettings();
}

async function orgServiceAction(action){
  try{
    await adminFetch('/api/organizer/'+action,{method:'POST'});
    await new Promise(r=>setTimeout(r,1200));
    renderOrgLogs();
  }catch{renderOrgLogs();}
}
async function renderOrgLogsPage(){
  const a=document.getElementById('contentArea');
  a.innerHTML=`<div class="dl-page">
    <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:4px">Organizer Logs</h2>
    <p style="color:var(--text-muted);font-size:.82rem;margin-bottom:12px">Media organizer activity — moves, matches, errors and scans</p>
    <div id="dlTabContent"></div>
  </div>`;
  renderOrgLogs();
}

async function renderOrgLogs(){
  const c=document.getElementById('dlTabContent');
  if(!c)return;
  let active=false;
  try{const r=await adminFetch('/api/organizer/status');const d=await r.json();active=d.active;}catch{}
  const statusBadge=active
    ?`<span style="background:#1a3a1a;color:#4caf50;border:1px solid #4caf50;border-radius:20px;padding:3px 10px;font-size:.78rem;font-weight:600">● Running</span>`
    :`<span style="background:#3a1a1a;color:#f44336;border:1px solid #f44336;border-radius:20px;padding:3px 10px;font-size:.78rem;font-weight:600">● Stopped</span>`;
  const ctrlBtns=active
    ?`<button class="btn btn-sm" onclick="orgServiceAction('stop')" style="font-size:.78rem;padding:6px 12px;background:#c0392b">Stop</button><button class="btn btn-sm" onclick="orgServiceAction('restart')" style="font-size:.78rem;padding:6px 12px">Restart</button>`
    :`<button class="btn btn-sm" onclick="orgServiceAction('start')" style="font-size:.78rem;padding:6px 12px;background:#27ae60">Start</button>`;
  c.innerHTML=`<div style="display:flex;align-items:center;gap:10px;padding:10px 14px 6px;flex-wrap:wrap">${statusBadge}<div style="display:flex;gap:6px;margin-left:auto">${ctrlBtns}<button class="btn btn-sm" onclick="renderOrgLogs()" style="font-size:.78rem;padding:6px 10px">&#8635;</button></div></div><div class="org-log-controls"><select id="orgLogFilter" onchange="orgLogFilter=this.value;renderOrgLogs()"><option value="all"${orgLogFilter==='all'?' selected':''}>All Activity</option><option value="moves"${orgLogFilter==='moves'?' selected':''}>Moves &amp; Matches</option><option value="errors"${orgLogFilter==='errors'?' selected':''}>Errors &amp; Skips</option><option value="scans"${orgLogFilter==='scans'?' selected':''}>Scan Summaries</option></select></div><div class="org-log-container" id="orgLogArea"><div style="text-align:center;padding:40px"><span class="dl-spinner" style="width:24px;height:24px;border-width:2px"></span></div></div>`;
  try{
    const r=await fetch('/api/organizer/logs?lines=500&filter='+orgLogFilter);
    const d=await r.json();
    const area=document.getElementById('orgLogArea');
    if(!area)return;
    if(!d.ok){area.innerHTML=`<div style="text-align:center;padding:40px;color:var(--text-muted)">${d.error||'Could not load logs'}</div>`;return;}
    if(!d.lines.length){area.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-muted)">No log entries found</div>';return;}
    area.innerHTML=d.lines.map(l=>{
      let cls='log-info';
      if(/Moved ->/.test(l))cls='log-move';
      else if(/\[MOVIE\].*Found|\[TV\].*Found/.test(l))cls='log-found';
      else if(/SKIP|No confident/i.test(l))cls='log-skip';
      else if(/ERROR|FAIL|rate limit/i.test(l))cls='log-error';
      else if(/Scan complete|====/.test(l))cls='log-scan';
      const tsMatch=l.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s*(.*)/);
      if(tsMatch)return `<div class="org-log-line ${cls}"><span class="org-log-ts">${tsMatch[1]}</span>${esc(tsMatch[2])}</div>`;
      return `<div class="org-log-line ${cls}">${esc(l)}</div>`;
    }).join('');
    area.scrollTop=area.scrollHeight;
  }catch{
    const area=document.getElementById('orgLogArea');
    if(area)area.innerHTML='<div style="text-align:center;padding:40px;color:var(--text-muted)">Could not reach the server</div>';
  }
}

async function dlPauseTorrent(hash){
  await fetch('/api/qbt/torrents/pause',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hashes:hash})});
  setTimeout(async()=>{await dlRefreshTorrents();renderDlActive();},500);
}
async function dlResumeTorrent(hash){
  await fetch('/api/qbt/torrents/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hashes:hash})});
  setTimeout(async()=>{await dlRefreshTorrents();renderDlActive();},500);
}
async function dlDeleteTorrent(hash,name){
  if(!confirm('Delete "'+name+'"? This will also delete downloaded files.'))return;
  await fetch('/api/qbt/torrents/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hashes:hash,deleteFiles:true})});
  setTimeout(async()=>{await dlRefreshTorrents();renderDlActive();},500);
}

// ══════════════════════════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════════════════════════
setSkip(10);
setFilter('all');
updateVolumeUI();
updateBoostUI();
async function initApp(){
  const startup=document.getElementById('startupScreen');
  const profile=document.getElementById('profileScreen');
  const msg=document.getElementById('startupMsg');
  const detail=document.getElementById('startupDetail');
  startup.style.display='';
  profile.style.display='none';
  document.getElementById('appContainer').style.display='none';

  let attempt=0;
  while(true){
    try{
      const r=await fetch('/api/health');
      if(r.ok){
        const health=await r.json();
        if(health.ready){
          break;
        }
        // Show status-specific messages
        const statusMessages={
          starting:'Preparing server...',
          loading:'Loading media library...',
          scanning:'Scanning media files...',
        };
        msg.textContent=statusMessages[health.status]||'Loading...';
        detail.textContent=`Uptime: ${Math.round(health.uptime)}s`;
      }
    }catch{
      attempt++;
      msg.textContent='Connecting to server...';
      detail.textContent=attempt>2?`Attempt ${attempt}`:'';
    }
    await new Promise(r=>setTimeout(r,2000));
  }

  msg.textContent='Almost ready...';
  detail.textContent='';
  try{await fetchConfig();}catch{}
  startup.style.display='none';
  await showProfileScreen();
}
initApp();
