(() => {
  const $ = (s) => document.querySelector(s);

  // ---------- storage ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let settings = Object.assign(
    { apiKey: '', model: 'gpt-4o-mini', system: 'You are a helpful assistant.', theme: 'dark' },
    store.get('cgc_settings', {})
  );
  let chats = store.get('cgc_chats', []);
  let currentId = null;
  let controller = null;
  let streaming = false;

  const saveChats = () => store.set('cgc_chats', chats);
  const saveSettings = () => store.set('cgc_settings', settings);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const currentChat = () => chats.find((c) => c.id === currentId) || null;

  // ---------- elements ----------
  const messagesEl = $('#messages');
  const chatEl = $('#chat');
  const welcomeEl = $('#welcome');
  const inputEl = $('#input');
  const sendBtn = $('#send');
  const historyEl = $('#history');
  const sidebar = $('#sidebar');
  const overlay = $('#overlay');
  const modal = $('#modal');

  // ---------- markdown ----------
  const escapeHtml = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(text) {
    return text
      .split(/(`[^`\n]+`)/g)
      .map((part, i) => {
        if (i % 2 === 1) return `<code class="inline">${escapeHtml(part.slice(1, -1))}</code>`;
        return escapeHtml(part)
          .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
      })
      .join('')
      .replace(/\n/g, '<br>');
  }

  function renderMarkdown(src) {
    const blocks = [];
    let text = src.replace(/```([\w+#.-]*)[^\n]*\n?([\s\S]*?)(```|$)/g, (m, lang, code) => {
      blocks.push({ lang, code: code.replace(/\n$/, '') });
      return `\n\u0000B${blocks.length - 1}\u0000\n`;
    });

    const out = [];
    let list = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join('\n')) + '</p>'); para = []; } };
    const flushList = () => {
      if (list) {
        out.push(`<${list.t}>` + list.items.map((i) => `<li>${inline(i)}</li>`).join('') + `</${list.t}>`);
        list = null;
      }
    };

    for (const line of text.split('\n')) {
      let m;
      if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^\u0000B(\d+)\u0000$/))) {
        flushPara(); flushList();
        const b = blocks[+m[1]];
        out.push(
          `<div class="code-block"><div class="code-head"><span>${escapeHtml(b.lang || 'code')}</span>` +
          `<button class="copy-btn" type="button">Copy</button></div>` +
          `<pre><code>${escapeHtml(b.code)}</code></pre></div>`
        );
        continue;
      }
      if ((m = line.match(/^(#{1,6})\s+(.*)/))) {
        flushPara(); flushList();
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)/))) {
        flushPara();
        if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
        flushPara();
        if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^>\s?(.*)/))) {
        flushPara(); flushList();
        out.push(`<blockquote>${inline(m[1])}</blockquote>`);
        continue;
      }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    return out.join('');
  }

  // ---------- rendering ----------
  function setContent(el, msg) {
    if (msg.error) { el.className = 'content error'; el.textContent = msg.content; return; }
    if (!msg.content) { el.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>'; return; }
    el.innerHTML = renderMarkdown(msg.content);
  }

  function addMessageEl(msg) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + msg.role;
    if (msg.role === 'user') {
      const b = document.createElement('div');
      b.className = 'bubble';
      b.textContent = msg.content;
      wrap.appendChild(b);
    } else {
      const av = document.createElement('div');
      av.className = 'avatar';
      av.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>';
      const c = document.createElement('div');
      c.className = 'content';
      setContent(c, msg);
      wrap.append(av, c);
    }
    messagesEl.appendChild(wrap);
    return wrap;
  }

  function renderMessages() {
    messagesEl.innerHTML = '';
    const chat = currentChat();
    const has = chat && chat.messages.length > 0;
    welcomeEl.classList.toggle('hidden', !!has);
    if (has) chat.messages.forEach(addMessageEl);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function renderHistory() {
    historyEl.innerHTML = '';
    if (!chats.length) {
      historyEl.innerHTML = '<div class="history-empty">No chats yet</div>';
      return;
    }
    chats.forEach((c) => {
      const item = document.createElement('div');
      item.className = 'history-item' + (c.id === currentId ? ' active' : '');
      const t = document.createElement('span');
      t.textContent = c.title;
      const del = document.createElement('button');
      del.className = 'del';
      del.title = 'Delete chat';
      del.textContent = '✕';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(c.id); });
      item.append(t, del);
      item.addEventListener('click', () => { if (!streaming) { currentId = c.id; renderHistory(); renderMessages(); closeSidebar(); } });
      historyEl.appendChild(item);
    });
  }

  function deleteChat(id) {
    if (streaming) return;
    chats = chats.filter((c) => c.id !== id);
    if (currentId === id) currentId = null;
    saveChats(); renderHistory(); renderMessages();
  }

  function newChat() {
    if (streaming) return;
    currentId = null;
    renderHistory(); renderMessages();
    closeSidebar();
    inputEl.focus();
  }

  // ---------- sending ----------
  function setStreaming(on) {
    streaming = on;
    $('#iconSend').classList.toggle('hidden', on);
    $('#iconStop').classList.toggle('hidden', !on);
    updateSendState();
  }

  function updateSendState() {
    sendBtn.disabled = !streaming && !inputEl.value.trim();
  }

  async function send(text) {
    if (streaming) return;
    if (!settings.apiKey) { openSettings('Add your OpenAI API key to start chatting.'); return; }

    let chat = currentChat();
    if (!chat) {
      chat = { id: uid(), title: text.replace(/\s+/g, ' ').slice(0, 40), messages: [], updated: Date.now() };
      chats.unshift(chat);
      currentId = chat.id;
    }
    chat.messages.push({ role: 'user', content: text });
    const reply = { role: 'assistant', content: '' };
    chat.messages.push(reply);
    chat.updated = Date.now();
    saveChats(); renderHistory(); renderMessages();

    const contentEl = messagesEl.lastElementChild.querySelector('.content');
    const payload = [];
    if (settings.system.trim()) payload.push({ role: 'system', content: settings.system.trim() });
    chat.messages
      .slice(0, -1)
      .filter((m) => !m.error && m.content)
      .slice(-30)
      .forEach((m) => payload.push({ role: m.role, content: m.content }));

    controller = new AbortController();
    setStreaming(true);

    let pending = false;
    const paint = () => {
      pending = false;
      const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
      setContent(contentEl, reply);
      if (nearBottom) chatEl.scrollTop = chatEl.scrollHeight;
    };
    const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(paint); } };

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.apiKey },
        body: JSON.stringify({ model: settings.model, messages: payload, stream: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let msg = `${res.status} ${res.statusText}`;
        try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          const t = l.trim();
          if (!t.startsWith('data:')) continue;
          const d = t.slice(5).trim();
          if (d === '[DONE]') continue;
          try {
            const delta = JSON.parse(d).choices?.[0]?.delta?.content;
            if (delta) { reply.content += delta; schedule(); }
          } catch {}
        }
      }
      if (!reply.content) { reply.content = '(The model returned an empty response.)'; reply.error = true; }
    } catch (e) {
      if (e.name === 'AbortError') {
        if (!reply.content) chat.messages.pop();
      } else {
        const hint = e instanceof TypeError ? 'Network error. Check your internet connection.' : e.message;
        if (reply.content) {
          reply.content += '\n\n_(Interrupted: ' + hint + ')_';
        } else {
          reply.content = hint;
          reply.error = true;
        }
      }
    } finally {
      controller = null;
      setStreaming(false);
      chat.updated = Date.now();
      saveChats();
      renderMessages();
      inputEl.focus();
    }
  }

  // ---------- settings modal ----------
  function openSettings(notice) {
    $('#apiKey').value = settings.apiKey;
    $('#apiKey').type = 'password';
    $('#toggleKey').textContent = 'Show';
    $('#model').value = settings.model;
    $('#system').value = settings.system;
    $('#theme').value = settings.theme;
    const n = $('#modalNotice');
    n.textContent = notice || '';
    n.classList.toggle('hidden', !notice);
    modal.classList.remove('hidden');
    closeSidebar();
    setTimeout(() => $('#apiKey').focus(), 0);
  }
  const closeSettings = () => modal.classList.add('hidden');

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    $('#modelLabel').textContent = settings.model;
  }

  $('#saveSettings').addEventListener('click', () => {
    settings.apiKey = $('#apiKey').value.trim();
    settings.model = $('#model').value.trim() || 'gpt-4o-mini';
    settings.system = $('#system').value;
    settings.theme = $('#theme').value;
    saveSettings(); applyTheme(); closeSettings();
  });
  $('#toggleKey').addEventListener('click', () => {
    const k = $('#apiKey');
    const show = k.type === 'password';
    k.type = show ? 'text' : 'password';
    $('#toggleKey').textContent = show ? 'Hide' : 'Show';
  });
  $('#clearAll').addEventListener('click', () => {
    if (streaming) return;
    if (confirm('Delete all chats? This cannot be undone.')) {
      chats = []; currentId = null; saveChats(); renderHistory(); renderMessages(); closeSettings();
    }
  });
  $('#openSettings').addEventListener('click', () => openSettings());
  $('#closeSettings').addEventListener('click', closeSettings);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeSettings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

  // ---------- sidebar (mobile) ----------
  function closeSidebar() { sidebar.classList.remove('open'); overlay.classList.remove('show'); }
  $('#openSidebar').addEventListener('click', () => { sidebar.classList.add('open'); overlay.classList.add('show'); });
  $('#closeSidebar').addEventListener('click', closeSidebar);
  overlay.addEventListener('click', closeSidebar);
  $('#newChat').addEventListener('click', newChat);

  // ---------- composer ----------
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }
  inputEl.addEventListener('input', () => { autosize(); updateSendState(); });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (streaming) { controller && controller.abort(); return; }
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autosize(); updateSendState();
    send(text);
  });
  document.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => send(c.dataset.prompt))
  );

  // copy buttons inside code blocks
  messagesEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = btn.closest('.code-block').querySelector('code').textContent;
    try { await navigator.clipboard.writeText(code); btn.textContent = 'Copied!'; }
    catch { btn.textContent = 'Failed'; }
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });

  // ---------- init ----------
  applyTheme();
  renderHistory();
  renderMessages();
  updateSendState();
  if (!settings.apiKey) openSettings('Paste your OpenAI API key to get started.');
})();
