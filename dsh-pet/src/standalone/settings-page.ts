/** Local-only settings shell; external same-origin assets keep CSP free of unsafe-inline. */
export const settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠 AI 设置</title><link rel="stylesheet" href="/standalone-ai/settings.css">
<script src="/standalone-ai/settings.js" defer></script></head><body>
<main><header><span class="fish" aria-hidden="true">🐾</span><p class="local">独立桌宠 / 本机设置</p>
<h1>桌宠 AI 设置</h1><p class="intro">配置你的大模型 API 接口，开启桌面聊天与碎碎念。<br>所有设置仅保存在本机，支持即时测试连接。</p></header>
<form id="settings" aria-describedby="privacy">
<fieldset><legend>模型连接</legend>
<label for="protocol">接口协议</label><select id="protocol" name="protocol"><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option></select>
<label for="baseUrl">接口地址（Base URL）</label><input id="baseUrl" name="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false" aria-describedby="endpoint-note"><p class="hint" id="endpoint-note">填写服务商提供的基础接口地址（支持 HTTP 与 HTTPS，通常以 /v1 结尾）。不要把密钥放进地址。</p>
<label for="model">模型名称</label><input id="model" name="model" type="text" maxlength="200" placeholder="填写服务商的模型 ID，例如 deepseek-chat" spellcheck="false">
<div class="key-heading"><label for="apiKey">API 密钥</label><span id="key-state" class="hint">尚未读取</span></div>
<input id="apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥" aria-describedby="key-note">
<p id="key-note" class="hint">密钥只写入本机配置，不会回显。留空不会删除旧密钥。</p>
<label class="check clear"><input id="clearApiKey" type="checkbox">清除已保存的密钥，并关闭 AI</label>
<label class="check"><input id="disableThinking" type="checkbox" aria-describedby="thinking-note">关闭模型思考</label>
<p id="thinking-note" class="hint">仅 OpenAI 兼容协议生效：请求带上 chat_template_kwargs.enable_thinking=false，适用于 llama.cpp / vLLM 部署的 Qwen 等思考模型（否则思考会占满输出上限、回复为空）。官方 OpenAI 接口不认这个参数，不要勾选。</p>
<label class="check enabled"><input id="enabled" type="checkbox">启用 AI 对话</label>
<div class="test-row"><button id="test-btn" type="button">测试连接</button><span id="test-result" class="test-result" role="status" aria-live="polite"></span></div>
</fieldset>
<fieldset><legend>定时自动碎碎念</legend>
<label class="check"><input id="automaticWhispers" type="checkbox" aria-describedby="cost">开启自动碎碎念</label>
<p id="cost" class="notice">开启后，桌宠会按设定间隔定时调用模型并在桌面上说话冒泡（产生 API 费用）。默认关闭；右键菜单中的手动对话与手动碎碎念不受此开关限制。</p>
<div class="pair"><div><label for="whisperIntervalSec">碎碎念间隔（秒）</label><input id="whisperIntervalSec" type="number" min="60" max="86400" step="1" value="300" required></div>
<div><label for="maxTokens">单次输出上限（tokens）</label><input id="maxTokens" type="number" min="128" max="4096" step="1" value="1024" required></div></div>
<p class="hint">间隔至少 60 秒，默认 300 秒。输出上限越小，单次回复越简短。</p>
</fieldset>
<fieldset id="pet-settings" hidden><legend>宠物</legend>
<div class="pair"><div><label for="petName">名字</label><input id="petName" type="text" maxlength="24" required spellcheck="false"></div>
<div><label for="petSize">大小（宽度 px）</label><input id="petSize" type="number" min="100" max="1500" step="1" value="500" required></div></div>
<p class="hint">改名字或大小后桌宠会重启一下，之后请从右键重新打开设置。</p>
<label for="petPersona">人设</label><textarea id="petPersona" rows="4" maxlength="2000" aria-describedby="persona-note"></textarea>
<p id="persona-note" class="hint">碎碎念、对话、看屏幕吐槽、串门都按它说话。留空就用默认人设（框里的灰字）。</p>
<label class="check"><input id="petWorkStatus" type="checkbox" aria-describedby="workstatus-note">头顶状态</label>
<p id="workstatus-note" class="hint">头顶显示「Claude 等你确认」「在 X 家做客」这类状态，并换成对应的动作。</p>
<label class="check"><input id="petBalance" type="checkbox" aria-describedby="balance-note">余额动画</label>
<p id="balance-note" class="hint">定时查余额、按档位换动作（独立模式的余额是随机数）；右键「查看余额」不受这个开关影响。</p>
<label class="check"><input id="petFixed" type="checkbox" aria-describedby="fixed-note">待在原地</label>
<p id="fixed-note" class="hint">不再自己转身、走开，只在原地待机和做小动作。</p>
<label class="check"><input id="whisperImageEnabled" type="checkbox">碎碎念、看屏幕吐槽时配表情包</label>
<label class="check"><input id="chatImageEnabled" type="checkbox">对话时配表情包</label>
<label for="chatMemoryRounds">对话记住最近几轮</label><input id="chatMemoryRounds" type="number" min="0" max="50" step="1" value="5" aria-describedby="memory-note">
<p id="memory-note" class="hint">一问一答算一轮，带进每次对话；越多越费 token，0 = 不记。</p>
<p class="hint">多只宠物时这里改的是第一只桌面宠物。物理手感、字体、表情包、贴哪个角等更多选项在 <code id="petConfigFile"></code> 里，改完右键「重载配置」。</p>
</fieldset>
<fieldset id="app-settings" hidden><legend>陪伴与提醒</legend>
<label class="check"><input id="screenEnabled" type="checkbox" aria-describedby="screen-note">定时看屏幕吐槽</label>
<p id="screen-note" class="hint">只在上面的接口是本机地址（127.0.0.1 / localhost）时生效，截图只发给本机模型；离开电脑或一分钟没碰键鼠时不看。开着自动碎碎念时，到点的那一句碎碎念换成看屏幕，两者不会互相顶掉。右键「看看我在干嘛」随时手动看，不受此开关限制。</p>
<label for="screenIntervalMin">看屏幕间隔（分钟）</label><input id="screenIntervalMin" type="number" min="3" max="1440" step="1" value="15">
<label class="check"><input id="sittingEnabled" type="checkbox" aria-describedby="sitting-note">久坐提醒</label>
<div class="pair"><div><label for="sittingAfterMin">连续坐多久提醒（分钟）</label><input id="sittingAfterMin" type="number" min="5" max="600" step="1" value="50"></div>
<div><label for="sittingRepeatMin">还没起身，每隔（分钟）</label><input id="sittingRepeatMin" type="number" min="5" max="600" step="1" value="20"></div></div>
<p id="sitting-note" class="hint">离开电脑 5 分钟以上算起身，重新计时。</p>
<label class="check"><input id="waterEnabled" type="checkbox" aria-describedby="water-note">喝水提醒</label>
<label for="waterEveryMin">喝水间隔（分钟）</label><input id="waterEveryMin" type="number" min="10" max="600" step="1" value="60">
<p id="water-note" class="hint">只累计在电脑前的时间，提醒一次后重新计时。</p>
<label class="check"><input id="offWorkEnabled" type="checkbox" aria-describedby="offwork-note">下班提醒</label>
<div class="pair"><div><label for="offWorkTime">下班时间</label><input id="offWorkTime" type="time" value="18:00" required></div>
<div><label for="offWorkLeadMin">提前多久提醒（分钟）</label><input id="offWorkLeadMin" type="number" min="0" max="120" step="1" value="10"></div></div>
<label class="check"><input id="offWorkWeekdaysOnly" type="checkbox">只在工作日（周一到周五）提醒</label>
<p id="offwork-note" class="hint">每天在下班前这么多分钟提醒一次，填 0 就是到点提醒；那会儿不在电脑前就等回来再说。</p>
<label for="greetAfterAwayMin">离开多久、回来时打招呼（分钟）</label><input id="greetAfterAwayMin" type="number" min="1" max="1440" step="1" value="10">
</fieldset>
<fieldset id="visit-settings" hidden><legend>局域网串门</legend>
<label class="check"><input id="visitEnabled" type="checkbox" aria-describedby="visit-note">开启局域网串门</label>
<p id="visit-note" class="hint">总开关：关着时不发信标、不开端口，局域网里什么都不做。开启后，同一局域网里开了串门的 dsh-pet 能互相看到，同一网络里的人也能认出这台电脑；网络上只传昵称、宠物名和两只宠物说的话，截图、在用的应用、Claude 进度都不会发出去。首次开启时 macOS 会询问是否允许访问本地网络。</p>
<div class="sub">
<label class="check"><input id="visitHosting" type="checkbox" aria-describedby="hosting-note">允许别人来我家做客</label>
<p id="hosting-note" class="hint">关掉后别人在局域网里看不到你；开着时每次进门也要你在右键菜单里点「让它进来」。</p>
<label class="check"><input id="visitVisiting" type="checkbox" aria-describedby="visiting-note">允许我的宠物出门做客</label>
<p id="visiting-note" class="hint">右键「串门」里列出附近的邻居，点了去敲门；附近还没有别的桌宠时显示「附近还没有邻居」。</p>
<label class="check"><input id="visitChat" type="checkbox" aria-describedby="chat-note">串门时用模型聊天</label>
<p id="chat-note" class="hint">两只宠物各用自己的人设和模型聊几句；关掉后只说固定的招呼和道别，不调用模型。</p>
<label class="check"><input id="visitAutoAdmit" type="checkbox" aria-describedby="autoadmit-note">熟人来敲门直接请进</label>
<p id="autoadmit-note" class="hint">在「邻居」里标成熟人的邻居来敲门时不再等主人点头，直接请进来；只在主人在电脑前时才自动，其余照旧等主人右键应门。</p>
<div class="pair"><div><label for="visitNickname">邻居看到的昵称</label><input id="visitNickname" type="text" maxlength="12" placeholder="留空用电脑登录名" spellcheck="false"></div>
<div><label for="visitStayMin">出门做客待多久（分钟）</label><input id="visitStayMin" type="number" min="1" max="60" step="1" value="10"></div></div>
</div>
</fieldset>
<fieldset id="neighbors-settings" hidden><legend>邻居</legend>
<p class="hint">来玩过的邻居记在本机（最多 50 位，超过丢最久没见的）。这一节的操作点了立即生效，不用按保存。记录只存本机，不出网。</p>
<div id="neighbor-list"></div>
<div class="pair"><div><button id="neighborsClear" type="button">全部忘掉</button></div>
<div><button id="identityReset" type="button">重置我的串门身份</button></div></div>
<p class="hint" id="identity-note">本机的串门身份是 <code id="identityId"></code>…。重置后大家都不认得这台电脑了，要重新串门、重新标熟人；串门进行中不能重置。局域网里有人做中间人时防不住冒充，别把这个身份当唯一凭据。</p>
</fieldset>
<footer><p id="privacy">所有配置与密钥仅保存在当前机器。<br>关闭 AI 后，桌宠仍可正常显示、移动与互动。</p><button id="save" type="submit" disabled>保存到本机</button></footer>
<p id="status" role="status" aria-live="polite">正在读取本机设置…</p>
</form><noscript>需要启用 JavaScript 才能保存设置。请从桌宠菜单打开本页。</noscript></main></body></html>`;

export const settingsStyle = `
:root{color-scheme:light;--ink:#203b4b;--muted:#526a78;--blue:#12618b;--line:#cbdce5;--paper:#fff;--water:#edf5fa}
*{box-sizing:border-box}body{margin:0;background:var(--water);color:var(--ink);font:16px/1.6 "Microsoft YaHei UI","PingFang SC",sans-serif}
main{max-width:720px;margin:48px auto;padding:0 24px 32px}header{padding:0 12px 28px}.fish{display:block;font:700 29px/1.3 Georgia,serif;color:var(--blue);letter-spacing:2px;margin-bottom:24px}.local{font-size:13px;color:var(--muted);margin:0 0 10px}h1{font-size:32px;line-height:1.3;letter-spacing:-1px;margin:0 0 16px;font-weight:700}.intro{margin:0;color:var(--muted)}
form{background:var(--paper);border:1px solid var(--line);border-radius:16px 16px 6px 6px;padding:28px 32px 20px}fieldset{padding:0 0 28px;margin:0 0 24px;border:0;border-bottom:1px solid var(--line);min-width:0}legend{font-size:19px;font-weight:700;margin-bottom:18px;padding:0}label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}input:not([type=checkbox]),select,textarea{display:block;width:100%;min-height:44px;border:1px solid #a5bdcb;border-radius:6px;background:#fff;color:var(--ink);padding:9px 12px;font:inherit;font-size:15px}input::placeholder,textarea::placeholder{color:#6a7e8b}textarea{resize:vertical;line-height:1.6}code{font-size:12px;word-break:break-all}input[type=checkbox]{accent-color:var(--blue);width:18px;height:18px;flex-shrink:0;margin:0}.check{display:flex;align-items:center;gap:10px;min-height:32px;cursor:pointer}.enabled{margin-top:24px}.clear{font-weight:400;color:var(--muted);font-size:13px}.hint{font-size:12px;line-height:1.6;color:var(--muted);margin:7px 0 0}.key-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.key-heading label{margin:0 0 6px}.key-heading .hint{margin:0 0 6px}.notice{font-size:13px;color:#704b13;background:#fff7e7;border-left:3px solid #c18e36;margin:12px 0 16px;padding:12px 14px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}.sub{margin:10px 0 0 8px;padding-left:20px;border-left:2px solid var(--line)}footer{display:flex;align-items:center;justify-content:space-between;gap:18px}footer p{font-size:12px;color:var(--muted);margin:0}button{border:0;border-radius:7px;min-height:44px;padding:10px 20px;background:var(--blue);color:#fff;font:600 15px/1.5 inherit;white-space:nowrap;cursor:pointer}button:hover{background:#0b4e73}button:disabled{opacity:.55;cursor:wait}:focus-visible{outline:3px solid #3a94c4;outline-offset:3px}#status{font-size:13px;min-height:24px;margin:18px 0 0;color:var(--blue)}#status[data-error=true]{color:#a13b30}
.test-row{display:flex;align-items:center;gap:14px;margin:20px 0 6px;flex-wrap:wrap}#test-btn{background:#fff;color:var(--blue);border:1.5px solid var(--blue);min-height:38px;padding:6px 18px;font-size:14px;border-radius:6px;cursor:pointer;font-weight:600}#test-btn:hover{background:#edf5fa}#test-btn:disabled{opacity:.6;cursor:wait}.test-result{font-size:13px;line-height:1.5;min-height:22px;flex:1 1 200px}.test-success{color:#1a7f37;font-weight:600}.test-error{color:#cf222e}.reply-preview{display:block;color:var(--muted);font-weight:normal;font-size:12px;margin-top:4px;word-break:break-all}
#neighbor-list:empty::after{content:'还没有记下过邻居，开着串门和别人来往过就会出现在这里。';display:block;font-size:12px;color:var(--muted);margin-top:8px}.neighbor-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:10px 0;border-bottom:1px dashed var(--line)}.neighbor-row>span{flex:1;min-width:200px;font-size:14px}.neighbor-row .check{margin:0;font-weight:400;font-size:13px}.neighbor-row button{background:#fff;color:var(--blue);border:1px solid var(--blue);min-height:34px;padding:4px 14px;font-size:13px}.neighbor-row button:hover{background:#edf5fa}
@media(max-width:560px){main{margin:24px auto;padding:0 14px 24px}header{padding:0 8px 24px}h1{font-size:28px}form{padding:24px 20px 16px}.pair{grid-template-columns:1fr;gap:0}footer{align-items:stretch;flex-direction:column}button{width:100%}.fish{margin-bottom:18px}}
`;

export const settingsScript = `
'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
  history.replaceState(null, '', location.pathname);
  const get = id => document.getElementById(id);
  const form = get('settings');
  const status = get('status');
  const save = get('save');
  const testBtn = get('test-btn');
  const testResult = get('test-result');
  function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
  async function request(method, body) {
    const response = await fetch('/standalone-ai/settings', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? {'Content-Type': 'application/json'} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    if (!response.ok) {
      if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
      if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
      throw new Error('设置未保存。请检查接口地址、模型名称与密钥，再重试。');
    }
    return response.json();
  }
  // 自动碎碎念只有一个开关：独立模式要设置里开着、且宠物配置里这只宠物的 whisperEnabled 也开着才会说；
  // 两边合起来显示，保存时开着就顺带把这只宠物的 whisperEnabled 打开（见下面「宠物」一节）
  let aiWhispers = false;
  let petWhispers = true;
  function syncWhispers() { get('automaticWhispers').checked = aiWhispers && petWhispers; }
  // 「陪伴与提醒」「局域网串门」只有独立应用有（/standalone-ai/app-settings）；CLI 里是 404，这两节保持隐藏
  const appSections = [get('app-settings'), get('visit-settings')];
  // 串门的细节开关挂在总开关下面：总开关关着时置灰（值照常保存，再打开时还是原来的选择）
  const visitDetails = ['visitHosting', 'visitVisiting', 'visitChat', 'visitAutoAdmit', 'visitNickname', 'visitStayMin'];
  function syncVisitDetails() { for (const id of visitDetails) get(id).disabled = !get('visitEnabled').checked; }
  get('visitEnabled').addEventListener('change', syncVisitDetails);
  let appAvailable = false;
  async function appRequest(method, body) {
    const response = await fetch('/standalone-ai/app-settings', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? {'Content-Type': 'application/json'} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(body ? '陪伴与提醒设置未保存，请检查数值范围。' : '陪伴与提醒设置读取失败。');
    return response.json();
  }
  function populateApp(data) {
    get('screenEnabled').checked = data.screen.enabled === true;
    get('screenIntervalMin').value = String(data.screen.intervalMin);
    get('sittingEnabled').checked = data.sitting.enabled === true;
    get('sittingAfterMin').value = String(data.sitting.afterMin);
    get('sittingRepeatMin').value = String(data.sitting.repeatMin);
    get('waterEnabled').checked = data.water.enabled === true;
    get('waterEveryMin').value = String(data.water.everyMin);
    get('offWorkEnabled').checked = data.offWork.enabled === true;
    get('offWorkTime').value = data.offWork.time;
    get('offWorkLeadMin').value = String(data.offWork.leadMin);
    get('offWorkWeekdaysOnly').checked = data.offWork.weekdaysOnly === true;
    get('greetAfterAwayMin').value = String(data.greetAfterAwayMin);
    get('visitEnabled').checked = data.visit.enabled === true;
    get('visitHosting').checked = data.visit.hosting === true;
    get('visitVisiting').checked = data.visit.visiting === true;
    get('visitChat').checked = data.visit.chat === true;
    get('visitAutoAdmit').checked = data.visit.autoAdmitFriends === true;
    get('visitNickname').value = data.visit.nickname;
    get('visitStayMin').value = String(data.visit.stayMin);
    syncVisitDetails();
  }
  // 「邻居」一节（/standalone-ai/app-neighbors）：邻居簿与串门身份；这里点的操作立即生效，不跟整页的保存按钮走
  async function neighborsRequest(method, body) {
    const response = await fetch('/standalone-ai/app-neighbors', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? {'Content-Type': 'application/json'} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || '邻居操作没成功，请稍后再试。');
    }
    return response.json();
  }
  // 邻居的昵称是对方电脑发来的文本：显示一律用 textContent 拼节点，不拼进 HTML
  function renderNeighbors(data) {
    get('identityId').textContent = data.id;
    const list = get('neighbor-list');
    list.textContent = '';
    for (const record of data.neighbors) {
      const row = document.createElement('div');
      row.className = 'neighbor-row';
      const label = document.createElement('span');
      label.textContent = record.owner + ' · ' + record.pet + ' · 来过 ' + record.hosted + ' 次 / 去过 ' +
        record.visited + ' 次 · 上次见面 ' + new Date(record.lastMet).toLocaleString();
      row.appendChild(label);
      const friend = document.createElement('label');
      friend.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = record.friend === true;
      box.addEventListener('change', () => {
        const want = box.checked;
        // 请求没成功就把勾选框改回去：不然停在改后的样子，和实际存的对不上
        void neighborsRequest('POST', {action: 'friend', id: record.id, friend: want})
          .catch(e => { box.checked = !want; message(e.message, true); });
      });
      friend.appendChild(box);
      friend.appendChild(document.createTextNode('熟人'));
      row.appendChild(friend);
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.textContent = '忘掉';
      forget.addEventListener('click', () => {
        void neighborsRequest('POST', {action: 'forget', id: record.id}).then(() => row.remove()).catch(e => message(e.message, true));
      });
      row.appendChild(forget);
      list.appendChild(row);
    }
  }
  function loadNeighbors() {
    return neighborsRequest('GET').then(data => { if (data) renderNeighbors(data); }).catch(e => message(e.message, true));
  }
  get('neighborsClear').addEventListener('click', () => {
    if (!confirm('忘掉全部邻居？熟人标记也会一起没了。')) return;
    void neighborsRequest('POST', {action: 'clear'}).then(loadNeighbors).catch(e => message(e.message, true));
  });
  get('identityReset').addEventListener('click', () => {
    if (!confirm('重置串门身份？重置后别的电脑都不认得这台电脑了，要重新串门、重新标熟人。')) return;
    void neighborsRequest('POST', {action: 'reset-identity'}).then(loadNeighbors).catch(e => message(e.message, true));
  });
  // 「宠物」一节改插件配置（main-config.jsonc）里的第一只桌面宠物：/standalone-ai/pet-settings 转给插件的 /config，
  // 其余宠物与没在这里的字段原样保留；只有独立应用有，CLI 里是 404
  let petConfig = null;
  async function petRequest(method, body) {
    const response = await fetch('/standalone-ai/pet-settings', {
      method, credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-DSH-Pet-Token': token, ...(body ? {'Content-Type': 'application/json'} : {}) },
      ...(body ? {body: JSON.stringify(body)} : {})
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || (body ? '宠物设置未保存，请检查名字和数值范围。' : '宠物设置读取失败。'));
    }
    return response.json();
  }
  function targetPet(config) {
    const pets = config && config.main && Array.isArray(config.main.pets) ? config.main.pets : [];
    return pets.find(pet => pet.display === 'desktop' || pet.display === 'both') || pets[0] || null;
  }
  function populatePet(data) {
    const pet = targetPet(data.config);
    if (!pet) return false;
    petConfig = data.config;
    get('petName').value = pet.name || pet.id;
    get('petSize').value = String(pet.size);
    get('petPersona').value = pet.whisperPrompt || '';
    get('petPersona').placeholder = petConfig.main.whisperPrompt || '';
    get('petWorkStatus').checked = pet.workStatusEnabled === true;
    get('petBalance').checked = pet.balanceEnabled === true;
    get('petFixed').checked = pet.fixedEnabled === true;
    get('whisperImageEnabled').checked = petConfig.main.whisperImageEnabled === true;
    get('chatImageEnabled').checked = petConfig.main.chatImageEnabled === true;
    get('chatMemoryRounds').value = String(petConfig.main.chatMemoryRounds);
    get('petConfigFile').textContent = data.file;
    petWhispers = pet.whisperEnabled === true;
    syncWhispers();
    return true;
  }
  function petBody() {
    const target = targetPet(petConfig);
    return {
      pets: petConfig.main.pets.map(pet => pet !== target ? pet : {
        ...pet,
        name: get('petName').value.trim(), size: num('petSize'), whisperPrompt: get('petPersona').value,
        workStatusEnabled: get('petWorkStatus').checked, balanceEnabled: get('petBalance').checked,
        fixedEnabled: get('petFixed').checked,
        // 关掉时不动它：设置里的开关已经拦住了自动碎碎念
        whisperEnabled: get('automaticWhispers').checked || pet.whisperEnabled === true
      }),
      whisperImageEnabled: get('whisperImageEnabled').checked, chatImageEnabled: get('chatImageEnabled').checked,
      chatMemoryRounds: num('chatMemoryRounds')
    };
  }
  const num = id => Number(get(id).value);
  function populate(data) {
    for (const id of ['protocol','baseUrl','model','whisperIntervalSec','maxTokens']) {
      if (data[id] !== undefined) get(id).value = String(data[id]);
    }
    for (const id of ['enabled','disableThinking']) get(id).checked = data[id] === true;
    aiWhispers = data.automaticWhispers === true;
    syncWhispers();
    get('key-state').textContent = data.hasKey ? '已保存 · 不回显' : '尚未设置';
    get('apiKey').value = '';
    get('clearApiKey').checked = false;
  }
  get('clearApiKey').addEventListener('change', () => {
    get('apiKey').disabled = get('clearApiKey').checked;
    if (get('clearApiKey').checked) {
      get('apiKey').value = '';
      get('enabled').checked = false;
      get('automaticWhispers').checked = false;
    }
  });
  if (testBtn && testResult) {
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      testResult.className = 'test-result';
      testResult.textContent = '正在测试连接，请稍候…';
      const input = {
        protocol: get('protocol').value,
        baseUrl: get('baseUrl').value.trim(),
        model: get('model').value.trim(),
        apiKey: get('apiKey').value.trim(),
        disableThinking: get('disableThinking').checked,
      };
      try {
        const response = await fetch('/standalone-ai/test', {
          method: 'POST',
          credentials: 'omit',
          cache: 'no-store',
          headers: {
            'X-DSH-Pet-Token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(input),
        });
        const data = await response.json();
        if (data.ok) {
          testResult.className = 'test-result test-success';
          testResult.textContent = '✓ ' + data.message;
          if (data.reply) {
            const preview = document.createElement('span');
            preview.className = 'reply-preview';
            preview.textContent = '回复: ' + data.reply;
            testResult.appendChild(preview);
          }
        } else {
          testResult.className = 'test-result test-error';
          testResult.textContent = '✗ ' + (data.message || data.error || '测试失败');
        }
      } catch (error) {
        testResult.className = 'test-result test-error';
        testResult.textContent = '✗ 请求异常：' + (error && error.message ? error.message : String(error));
      } finally {
        testBtn.disabled = false;
      }
    });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    message('正在保存到本机…');
    const input = {
      protocol: get('protocol').value, baseUrl: get('baseUrl').value.trim(), model: get('model').value.trim(),
      apiKey: get('apiKey').value, clearApiKey: get('clearApiKey').checked,
      enabled: get('enabled').checked, automaticWhispers: get('automaticWhispers').checked,
      disableThinking: get('disableThinking').checked,
      whisperIntervalSec: Number(get('whisperIntervalSec').value), maxTokens: Number(get('maxTokens').value)
    };
    // 宠物这一节按点保存这一刻的表单算好：下面存完 AI 设置会重新显示碎碎念开关
    const petInput = petConfig ? petBody() : null;
    const petBefore = petConfig ? targetPet(petConfig) : null;
    get('apiKey').value = '';
    try {
      populate(await request('POST', input));
      get('apiKey').disabled = false;
      if (appAvailable) {
        populateApp(await appRequest('POST', {
          greetAfterAwayMin: num('greetAfterAwayMin'),
          screen: { enabled: get('screenEnabled').checked, intervalMin: num('screenIntervalMin') },
          sitting: { enabled: get('sittingEnabled').checked, afterMin: num('sittingAfterMin'), repeatMin: num('sittingRepeatMin') },
          water: { enabled: get('waterEnabled').checked, everyMin: num('waterEveryMin') },
          offWork: { enabled: get('offWorkEnabled').checked, time: get('offWorkTime').value, weekdaysOnly: get('offWorkWeekdaysOnly').checked, leadMin: num('offWorkLeadMin') },
          visit: {
            enabled: get('visitEnabled').checked, hosting: get('visitHosting').checked, visiting: get('visitVisiting').checked,
            chat: get('visitChat').checked, autoAdmitFriends: get('visitAutoAdmit').checked,
            nickname: get('visitNickname').value.trim(), stayMin: num('visitStayMin')
          }
        }));
      }
      let relaunching = false;
      if (petInput) {
        const after = petInput.pets.find(pet => pet.id === petBefore.id);
        relaunching = after.name !== petBefore.name || after.size !== petBefore.size;
        populatePet(await petRequest('POST', petInput));
      }
      message(relaunching ? '已保存到本机。桌宠正在重启，之后请从右键重新打开设置。' : '已保存到本机。');
    } catch (error) { message(error.message, true); }
    finally { save.disabled = false; }
  });
  if (!token) { message('请从桌宠菜单或本机启动器打开设置，以获得本次运行的访问凭据。', true); return; }
  request('GET').then(data => { populate(data); save.disabled = false; message('设置只在本机保存。'); })
    .catch(error => message(error.message, true));
  appRequest('GET').then(data => { if (data) { populateApp(data); for (const section of appSections) section.hidden = false; appAvailable = true; } })
    .catch(error => message(error.message, true));
  neighborsRequest('GET').then(data => { if (data) { renderNeighbors(data); get('neighbors-settings').hidden = false; } })
    .catch(error => message(error.message, true));
  petRequest('GET').then(data => { if (data && populatePet(data)) get('pet-settings').hidden = false; })
    .catch(error => message(error.message, true));
})();
`;
