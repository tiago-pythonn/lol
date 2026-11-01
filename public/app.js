'use strict';

(() => {
  const app = document.getElementById('app');
  const list = document.getElementById('list');
  const main = document.getElementById('main');
  const overlay = document.getElementById('overlay');
  const toasts = document.getElementById('toasts');
  const state = {
    user: null,
    conversations: [],
    selectedId: '',
    messages: [],
    polling: false,
  };
  let toastTimer;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const result = await response.json().catch(() => {
      throw new Error('O servidor retornou uma resposta inválida.');
    });
    if (!response.ok) {
      const error = new Error(result.error || 'Não foi possível concluir a solicitação.');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function initials(value) {
    return (value || '?').trim().split(/\s+/).slice(0, 2)
      .map(part => part[0] || '').join('').toUpperCase() || '?';
  }

  function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toasts.replaceChildren(toast);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 3000);
  }

  function makeField(form, { label: labelText, name, placeholder, type = 'text', required = false, minLength }) {
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.name = name;
    input.type = type;
    input.placeholder = placeholder;
    input.required = required;
    input.autocomplete = name === 'password'
      ? (form.dataset.mode === 'register' ? 'new-password' : 'current-password')
      : name === 'username' ? 'username' : 'name';
    if (minLength) input.minLength = minLength;
    label.append(input);
    form.append(label);
    return input;
  }

  function showAuth(mode = 'register') {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback';
    const form = document.createElement('form');
    form.className = 'modal';
    form.dataset.mode = mode;
    const title = document.createElement('h2');
    title.textContent = mode === 'register' ? 'Crie sua conta' : 'Entre no Zacord';
    const description = document.createElement('p');
    description.textContent = mode === 'register'
      ? 'Cadastre-se para conversar com seus amigos.'
      : 'Entre com seu username e senha para ver suas conversas.';
    form.append(title, description);
    if (mode === 'register') {
      makeField(form, {
        label: 'Seu nome',
        name: 'displayName',
        placeholder: 'Como podemos te chamar?',
        required: true,
      });
    }
    const username = makeField(form, {
      label: 'Username',
      name: 'username',
      placeholder: 'ex.: ana_silva',
      required: true,
    });
    username.maxLength = 20;
    const password = makeField(form, {
      label: 'Senha',
      name: 'password',
      type: 'password',
      placeholder: 'Mínimo de 8 caracteres',
      required: true,
      minLength: 8,
    });
    password.maxLength = 128;
    const error = document.createElement('div');
    error.className = 'hint';
    error.setAttribute('role', 'alert');
    error.style.color = '#ff929e';
    form.append(error);

    const switchLine = document.createElement('p');
    switchLine.style.margin = '15px 0 0';
    switchLine.style.fontSize = '12px';
    const switchButton = document.createElement('button');
    switchButton.type = 'button';
    switchButton.className = 'icon';
    switchButton.style.fontSize = '12px';
    switchButton.textContent = mode === 'register' ? 'Já tem conta? Entrar' : 'Ainda não tem conta? Criar conta';
    switchButton.onclick = () => showAuth(mode === 'register' ? 'login' : 'register');
    switchLine.append(switchButton);

    const footer = document.createElement('div');
    footer.className = 'modalfoot';
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = mode === 'register' ? 'Criar conta' : 'Entrar';
    footer.append(submit);
    form.append(switchLine, footer);
    form.onsubmit = async event => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form));
        const endpoint = mode === 'register' ? '/api/register' : '/api/login';
        const result = await api(endpoint, { method: 'POST', body: JSON.stringify(values) });
        state.user = result.user;
        backdrop.remove();
        await startApp();
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        submit.disabled = false;
      }
    };
    backdrop.append(form);
    overlay.replaceChildren(backdrop);
    (mode === 'register' ? form.elements.displayName : username).focus();
  }

  function updateProfile() {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback';
    const form = document.createElement('form');
    form.className = 'modal';
    const title = document.createElement('h2');
    title.textContent = 'Seu perfil';
    const description = document.createElement('p');
    description.textContent = 'Atualize seu nome e username.';
    form.append(title, description);
    const displayName = makeField(form, {
      label: 'Nome',
      name: 'displayName',
      placeholder: 'Seu nome',
      required: true,
    });
    displayName.value = state.user.displayName;
    const username = makeField(form, {
      label: 'Username',
      name: 'username',
      placeholder: 'ex.: ana_silva',
      required: true,
    });
    username.value = state.user.username;
    username.maxLength = 20;
    const error = document.createElement('div');
    error.className = 'hint';
    error.setAttribute('role', 'alert');
    error.style.color = '#ff929e';
    form.append(error);

    const footer = document.createElement('div');
    footer.className = 'modalfoot';
    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'secondary';
    logout.textContent = 'Sair';
    logout.onclick = async () => {
      try {
        await api('/api/logout', { method: 'POST' });
        clearInterval(state.pollingTimer);
        state.user = null;
        state.conversations = [];
        state.selectedId = '';
        state.messages = [];
        app.classList.remove('chat-open');
        backdrop.remove();
        render();
        showAuth('login');
      } catch (requestError) {
        error.textContent = requestError.message;
      }
    };
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancelar';
    cancel.onclick = () => backdrop.remove();
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'primary';
    save.textContent = 'Salvar';
    footer.append(logout, cancel, save);
    form.append(footer);
    form.onsubmit = async event => {
      event.preventDefault();
      error.textContent = '';
      save.disabled = true;
      try {
        const result = await api('/api/me', {
          method: 'PATCH',
          body: JSON.stringify(Object.fromEntries(new FormData(form))),
        });
        state.user = result.user;
        backdrop.remove();
        render();
        showToast('Perfil atualizado.');
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        save.disabled = false;
      }
    };
    backdrop.append(form);
    overlay.replaceChildren(backdrop);
    displayName.focus();
  }

  function selectedConversation() {
    return state.conversations.find(conversation => conversation.id === state.selectedId);
  }

  function renderList() {
    const query = document.getElementById('search').value.toLowerCase();
    list.replaceChildren();
    const conversations = state.conversations.filter(conversation =>
      `${conversation.name} ${conversation.username} ${conversation.lastMessage?.text || ''}`
        .toLowerCase().includes(query));
    if (!conversations.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding:20px 10px;color:var(--muted);font-size:12px;text-align:center';
      empty.textContent = query
        ? 'Nenhuma conversa encontrada.'
        : 'Adicione um contato ou crie seu primeiro grupo.';
      list.append(empty);
      return;
    }

    conversations.forEach(conversation => {
      const button = document.createElement('button');
      button.className = `chat${state.selectedId === conversation.id ? ' selected' : ''}`;
      button.onclick = () => selectConversation(conversation.id);
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initials(conversation.name);
      const copy = document.createElement('div');
      copy.className = 'copy';
      const line = document.createElement('div');
      line.className = 'chatline';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = conversation.name;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = conversation.lastMessage ? formatTime(conversation.lastMessage.time) : '';
      line.append(name, time);
      const preview = document.createElement('div');
      preview.className = 'preview';
      preview.textContent = conversation.lastMessage
        ? `${conversation.lastMessage.senderUsername.toLowerCase() === state.user.username.toLowerCase() ? 'Você: ' : ''}${conversation.lastMessage.text}`
        : conversation.isGroup ? `${conversation.members} participantes` : `@${conversation.username}`;
      copy.append(line, preview);
      button.append(avatar, copy);
      list.append(button);
    });
  }

  function formatTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function renderMessageList(shouldScroll) {
    const messages = main.querySelector('.messages');
    if (!messages) return;
    const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 100;
    messages.replaceChildren();
    const day = document.createElement('div');
    day.className = 'day';
    day.textContent = state.messages.length ? 'HISTÓRICO DA CONVERSA' : 'Esta conversa começa aqui';
    messages.append(day);
    state.messages.forEach(message => {
      const mine = message.username.toLowerCase() === state.user.username.toLowerCase();
      const row = document.createElement('article');
      row.className = `message${mine ? ' mine' : ''}`;
      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      avatar.textContent = initials(mine ? state.user.displayName : message.displayName);
      const box = document.createElement('div');
      box.className = 'bubblebox';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const author = document.createElement('strong');
      author.textContent = mine ? state.user.displayName : message.displayName;
      const stamp = document.createElement('span');
      stamp.textContent = formatTime(message.time);
      meta.append(author, stamp);
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = message.text;
      box.append(meta, bubble);
      row.append(avatar, box);
      messages.append(row);
    });
    if (shouldScroll || wasNearBottom) messages.scrollTop = messages.scrollHeight;
  }

  function renderChat() {
    const conversation = selectedConversation();
    if (!conversation) {
      delete main.dataset.conversationId;
      main.innerHTML = '<section class="empty"><div class="emptybox"><div class="empty-icon">✦</div><h2>Converse do seu jeito</h2><p>Adicione contatos pelo username, crie grupos e mantenha tudo em um só lugar.</p><button class="primary" id="start">＋ Adicionar contato</button></div></section>';
      document.getElementById('start').onclick = addContact;
      return;
    }

    main.dataset.conversationId = conversation.id;
    main.replaceChildren();
    const header = document.createElement('header');
    header.className = 'topbar';
    const back = document.createElement('button');
    back.className = 'actions back';
    back.textContent = '‹';
    back.title = 'Voltar';
    back.onclick = () => app.classList.remove('chat-open');
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(conversation.name);
    const copy = document.createElement('div');
    copy.className = 'topcopy';
    const title = document.createElement('div');
    title.className = 'topname';
    title.textContent = conversation.name;
    const status = document.createElement('div');
    status.className = 'status';
    status.textContent = conversation.isGroup
      ? `Grupo · ${conversation.members} participantes`
      : `@${conversation.username}`;
    copy.append(title, status);
    const actions = document.createElement('div');
    actions.className = 'actions';
    [['☎', 'Chamada de voz'], ['▣', 'Chamada de vídeo']].forEach(([symbol, label]) => {
      const button = document.createElement('button');
      button.textContent = symbol;
      button.title = label;
      button.onclick = () => showCall(conversation, label);
      actions.append(button);
    });
    header.append(back, avatar, copy, actions);
    main.append(header);

    const messages = document.createElement('section');
    messages.className = 'messages';
    messages.setAttribute('aria-label', 'Mensagens');
    main.append(messages);
    renderMessageList(true);

    const area = document.createElement('div');
    area.className = 'composer-area';
    const form = document.createElement('form');
    form.className = 'composer';
    const emoji = document.createElement('button');
    emoji.type = 'button';
    emoji.textContent = '☺';
    emoji.title = 'Inserir emoji';
    const input = document.createElement('input');
    input.name = 'text';
    input.placeholder = 'Escreva uma mensagem...';
    input.maxLength = 2000;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Escreva uma mensagem');
    emoji.onclick = () => {
      input.value += '🙂';
      input.focus();
    };
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'send';
    send.textContent = '➤';
    send.title = 'Enviar mensagem';
    form.append(emoji, input, send);
    form.onsubmit = async event => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await api(`/api/conversations/${conversation.id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ text }),
        });
        input.value = '';
        await refreshData();
        input.focus();
      } catch (error) {
        showToast(error.message);
      } finally {
        send.disabled = false;
      }
    };
    area.append(form);
    main.append(area);
  }

  function showCall(conversation, label) {
    document.querySelector('.call')?.remove();
    const box = document.createElement('div');
    box.className = 'call';
    const title = document.createElement('strong');
    title.textContent = `${label} · ${conversation.name}`;
    const note = document.createElement('small');
    note.textContent = 'Chamada de demonstração';
    const end = document.createElement('button');
    end.textContent = 'Encerrar';
    end.onclick = () => box.remove();
    box.append(title, note, end);
    document.body.append(box);
  }

  function render() {
    const name = state.user?.displayName || 'Visitante';
    document.getElementById('profileName').textContent = name;
    document.getElementById('profileAvatar').textContent = initials(name);
    document.getElementById('myAvatar').textContent = initials(name);
    renderList();
    renderChat();
  }

  async function refreshData() {
    const { conversations } = await api('/api/conversations');
    state.conversations = conversations;
    if (state.selectedId && !conversations.some(item => item.id === state.selectedId)) {
      state.selectedId = '';
      state.messages = [];
    }
    renderList();
    if (state.selectedId) {
      if (main.dataset.conversationId !== state.selectedId) renderChat();
      const { messages } = await api(`/api/conversations/${state.selectedId}/messages`);
      state.messages = messages;
      renderMessageList(false);
    } else {
      renderChat();
    }
  }

  async function selectConversation(id) {
    state.selectedId = id;
    state.messages = [];
    render();
    app.classList.add('chat-open');
    try {
      const { messages } = await api(`/api/conversations/${id}/messages`);
      if (state.selectedId !== id) return;
      state.messages = messages;
      renderMessageList(true);
    } catch (error) {
      showToast(error.message);
    }
  }

  function showModal(titleText, descriptionText, fields, submitText, onSubmit) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modalback';
    const form = document.createElement('form');
    form.className = 'modal';
    const title = document.createElement('h2');
    title.textContent = titleText;
    const description = document.createElement('p');
    description.textContent = descriptionText;
    form.append(title, description);
    fields.forEach(field => {
      const input = makeField(form, field);
      input.maxLength = field.maxLength || 60;
      if (field.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = field.hint;
        form.append(hint);
      }
      if (field.focus) input.focus();
    });
    const error = document.createElement('div');
    error.className = 'hint';
    error.setAttribute('role', 'alert');
    error.style.color = '#ff929e';
    form.append(error);
    const footer = document.createElement('div');
    footer.className = 'modalfoot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.textContent = 'Cancelar';
    cancel.onclick = () => backdrop.remove();
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'primary';
    submit.textContent = submitText;
    footer.append(cancel, submit);
    form.append(footer);
    form.onsubmit = async event => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await onSubmit(Object.fromEntries(new FormData(form)));
        backdrop.remove();
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        submit.disabled = false;
      }
    };
    backdrop.onclick = event => {
      if (event.target === backdrop) backdrop.remove();
    };
    backdrop.append(form);
    overlay.replaceChildren(backdrop);
  }

  function addContact() {
    showModal(
      'Adicionar contato',
      'Encontre alguém pelo username.',
      [{
        label: 'Username',
        name: 'username',
        placeholder: 'ex.: maria_oliveira',
        required: true,
        maxLength: 20,
        focus: true,
      }],
      'Adicionar',
      async values => {
        const { conversation } = await api('/api/conversations', {
          method: 'POST',
          body: JSON.stringify({ username: values.username }),
        });
        state.selectedId = conversation.id;
        state.messages = [];
        await refreshData();
        app.classList.add('chat-open');
      },
    );
  }

  function makeGroup() {
    showModal(
      'Criar grupo',
      'Informe o nome do grupo e os usernames dos participantes.',
      [
        {
          label: 'Nome do grupo',
          name: 'name',
          placeholder: 'ex.: Amigos do bairro',
          required: true,
          maxLength: 40,
          focus: true,
        },
        {
          label: 'Participantes',
          name: 'usernames',
          placeholder: 'ana_silva, joao123',
          required: true,
          hint: 'Separe os usernames por vírgula. Você será adicionado automaticamente.',
        },
      ],
      'Criar grupo',
      async values => {
        const usernames = values.usernames.split(',').map(value => value.trim()).filter(Boolean);
        const { conversation } = await api('/api/groups', {
          method: 'POST',
          body: JSON.stringify({ name: values.name, usernames }),
        });
        state.selectedId = conversation.id;
        state.messages = [];
        await refreshData();
        app.classList.add('chat-open');
      },
    );
  }

  async function startApp() {
    render();
    await refreshData();
    clearInterval(state.pollingTimer);
    state.pollingTimer = setInterval(async () => {
      if (state.polling) return;
      state.polling = true;
      try {
        await refreshData();
      } catch (error) {
        if (error.status === 401) {
          clearInterval(state.pollingTimer);
          state.user = null;
          showAuth('login');
        } else {
          showToast(error.message);
        }
      } finally {
        state.polling = false;
      }
    }, 2500);
  }

  document.getElementById('add').onclick = addContact;
  document.getElementById('add2').onclick = addContact;
  document.getElementById('groups').onclick = makeGroup;
  document.getElementById('settings').onclick = updateProfile;
  document.getElementById('search').oninput = renderList;

  api('/api/me')
    .then(async ({ user }) => {
      state.user = user;
      await startApp();
    })
    .catch(error => {
      if (error.status === 401) {
        showAuth('register');
      } else {
        showToast(error.message);
        showAuth('register');
      }
    });
})();
