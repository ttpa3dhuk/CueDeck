import { t, getLang } from '../shared/i18n.js'
/** Self-contained page: no CDN, cookies, trackers or remote assets. */
export function mobileClickerPage(options: { guestOpen?: boolean } = {}): string { return `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>${t('CueDeck · Кликер')}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#101724;color:#fff;font:20px system-ui,sans-serif;min-height:100dvh;padding:24px;display:flex;flex-direction:column;gap:20px;text-align:center}
h1{font-size:18px;font-weight:500;margin:0;color:#bdc9dc}#timer{font-size:clamp(56px,18vw,100px);font-variant-numeric:tabular-nums;font-weight:650;line-height:1.2}#timer[data-color=green]{color:#62dfa0}#timer[data-color=yellow]{color:#ffe071}#timer[data-color=red]{color:#ff7373}
#slides{font-size:25px}#remaining{font-size:17px;color:#bdc9dc;margin-top:6px}.buttons{display:grid;grid-template-columns:1fr 1fr;gap:18px;flex:1;min-height:180px}button{border:0;border-radius:22px;font:600 clamp(24px,6vw,42px) system-ui;touch-action:manipulation;user-select:none;min-height:150px;color:#fff}#prev{background:#b73640}#next{background:#19784b}button:active{filter:brightness(1.25)}button:disabled{background:#293140!important;color:#858d9b;opacity:1}#status{font-size:15px;color:#bdc9dc;min-height:22px}button:focus-visible{outline:4px solid #fff;outline-offset:4px}
#join{font-size:16px}#join input{width:100%;padding:12px;margin:8px 0;border:1px solid #7c899e;border-radius:8px;font:inherit}#join button{width:100%;min-height:48px;border-radius:8px;background:#2868bd;font:600 18px system-ui}#join[hidden]{display:none}
@media(orientation:landscape) and (max-height:550px){body{padding:12px;gap:8px}#timer{font-size:48px}.buttons{min-height:100px}button{min-height:90px}}
</style></head><body><h1>${t('CueDeck · Мобильный кликер')}</h1><div id="timer" data-color="neutral">--:--</div><div><div id="slides">${t('Нет материала')}</div><div id="remaining"></div></div>
<form id="join" hidden><label for="join-name">${t('Ваше имя (необязательно)')}</label><input id="join-name" maxlength="80" autocomplete="nickname"><button id="join-submit" type="submit">${t('Запросить доступ')}</button></form>
<div class="buttons"><button id="prev" disabled aria-label="${t('Предыдущий слайд')}">${t('◀ Назад')}</button><button id="next" disabled aria-label="${t('Следующий слайд')}">${t('Вперёд ▶')}</button></div><div id="device" style="font-size:14px;color:#bdc9dc"></div><div id="status" role="status">${t('Подключение…')}</div>
<script>
let key=new URLSearchParams(location.hash.slice(1)).get('key')||'';try{key=key||sessionStorage.getItem('cuedeck-key')||'';sessionStorage.setItem('cuedeck-key',key)}catch{}
try{history.replaceState(null,'',location.pathname)}catch{}
let client='';try{client=sessionStorage.getItem('cuedeck-client')||''}catch{}
if(!/^[a-zA-Z0-9-]{16,80}$/.test(client)){const bytes=new Uint8Array(24);crypto.getRandomValues(bytes);client=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');try{sessionStorage.setItem('cuedeck-client',client)}catch{}}
const timer=document.getElementById('timer'),slides=document.getElementById('slides'),remaining=document.getElementById('remaining'),status=document.getElementById('status'),prev=document.getElementById('prev'),next=document.getElementById('next');
const join=document.getElementById('join'),joinName=document.getElementById('join-name'),joinSubmit=document.getElementById('join-submit');
document.getElementById('device').textContent=${JSON.stringify(t('Код подключения: '))}+client.slice(0,8);
let connected=false,allowed=false,busy=false,failures=0,pollTimer,version=0,joining=false;
function buttons(){prev.disabled=next.disabled=!connected||!allowed||busy}
function pageError(message,fatal=false){const error=Error(message);error.clicker=true;error.fatal=fatal;return error}
function adoptKey(value){key=value;version++;failures=0;connected=false;allowed=false;busy=false;clearTimeout(pollTimer);try{sessionStorage.setItem('cuedeck-key',key);history.replaceState(null,'',location.pathname)}catch{}join.hidden=true;buttons();poll()}
async function request(path,options={}){
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),7500);
  try{
    const response=await fetch(path,{...options,signal:controller.signal,headers:{...(key?{Authorization:'Bearer '+key}:{}),'Content-Type':'application/json','X-Clicker-Client':client}});
    if(!response.ok)throw pageError(response.status===401?${JSON.stringify(t('Доступ истёк или ссылка отозвана. Запросите доступ заново.'))}:response.status===403?${JSON.stringify(t('Подключение отклонено. Проверьте онлайн режим и адрес CLOUDPUB в CueDeck.'))}:response.status===429?${JSON.stringify(t('Слишком много подключений или запросов. Повторите попытку позже.'))}:${JSON.stringify(t('Нет связи с CueDeck'))},response.status===401);
    try{return await response.json()}catch{throw pageError(${JSON.stringify(t('Вместо данных кликера получена страница. Проверьте публикацию CLOUDPUB.'))})}
  }finally{clearTimeout(timeout)}
}
async function poll(){
  const current=version;
  try{
    const s=await request('/state');if(current!==version)return;
    if(!s||typeof s.enabled!=='boolean'||!s.timer||typeof s.timer.text!=='string')throw pageError(${JSON.stringify(t('Вместо данных кликера получена страница. Проверьте публикацию CLOUDPUB.'))});
    failures=0;connected=true;allowed=s.enabled&&s.canNavigate;timer.textContent=s.timer.text;timer.dataset.color=s.timer.color;
    slides.textContent=s.access==='presentation'?${JSON.stringify(t('Ваша презентация не открыта'))}:s.total?${JSON.stringify(t('Слайд {n} из {total}'))}.replace('{n}',s.current).replace('{total}',s.total):${JSON.stringify(t('Нет материала'))};
    remaining.textContent=s.total?${JSON.stringify(t('Осталось слайдов: {n}'))}.replace('{n}',s.remaining):'';
    status.textContent=s.access==='approval'?${JSON.stringify(t('Ожидайте разрешения оператора'))}:s.access==='presentation'?${JSON.stringify(t('Ваша презентация не открыта'))}:!s.enabled?${JSON.stringify(t('Ожидайте включения кликера'))}:s.canNavigate?${JSON.stringify(t('Подключено'))}:s.total?${JSON.stringify(t('Листание сейчас недоступно'))}:${JSON.stringify(t('Ожидаем материал в эфире'))};
  }catch(e){
    if(current!==version)return;
    failures++;connected=false;allowed=false;status.textContent=e.clicker?e.message:${JSON.stringify(t('Нет связи с CueDeck'))};timer.textContent='--:--';slides.textContent=${JSON.stringify(t('Нет связи'))};remaining.textContent='';
    if(e.fatal){key='';join.hidden=false;try{sessionStorage.removeItem('cuedeck-key')}catch{}}
  }finally{if(current===version){buttons();if(key)pollTimer=setTimeout(poll,document.hidden?5000:Math.min(15000,1000*Math.pow(2,Math.min(failures,4))))}}
}
async function press(direction){
  const current=version;if(busy||!connected||!allowed)return;busy=true;buttons();
  try{await request('/command',{method:'POST',body:JSON.stringify({direction,id:crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)})})}
  catch(e){if(current===version){connected=false;status.textContent=${JSON.stringify(t('Команда не подтверждена. Проверьте слайд перед повтором.'))}}}
  finally{if(current===version){busy=false;buttons()}}
}
join.addEventListener('submit',async event=>{
  event.preventDefault();if(joining)return;joining=true;joinSubmit.disabled=true;
  try{const result=await request('/join',{method:'POST',body:JSON.stringify({name:joinName.value})});if(typeof result.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.key))throw pageError(${JSON.stringify(t('Нет связи с CueDeck'))});adoptKey(result.key)}
  catch(e){status.textContent=e.clicker?e.message:${JSON.stringify(t('Нет связи с CueDeck'))}}
  finally{joining=false;joinSubmit.disabled=false}
});
window.addEventListener('hashchange',()=>{const incoming=new URLSearchParams(location.hash.slice(1)).get('key');if(incoming)adoptKey(incoming)});
prev.addEventListener('click',()=>press('prev'));next.addEventListener('click',()=>press('next'));
if(key)poll();else{join.hidden=false;status.textContent=${JSON.stringify(t('Запросите доступ. Оператор разрешит нужные презентации.'))};buttons();${options.guestOpen ? 'join.requestSubmit()' : ''}}
</script></body></html>` }
