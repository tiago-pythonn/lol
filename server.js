'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = 'zacord_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const STATIC_FILES = new Set([
  'app.js',
  'loginreal.css',
  'loginreal.html',
  'login_zacord.html',
  'zacord_index.css',
  'zacord_index.html',
]);
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createServer({ dataFile = process.env.ZACORD_DATA_FILE || path.join(ROOT, 'data.json') } = {}) {
  const sessions = new Map();
  let store;

  try {
    store = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!Array.isArray(store.users) || !Array.isArray(store.conversations)) {
      throw new Error('O arquivo de dados não possui um formato válido.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`Não foi possível carregar os dados do Zacord: ${error.message}`);
    }
    store = { users: [], conversations: [] };
  }

  function persist() {
    const temporaryFile = `${dataFile}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    try {
      fs.writeFileSync(temporaryFile, JSON.stringify(store, null, 2), { mode: 0o600 });
      fs.renameSync(temporaryFile, dataFile);
    } catch (error) {
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      throw error;
    }
  }

  function sendJson(response, status, value, headers = {}) {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    response.end(JSON.stringify(value));
  }

  function readJson(request) {
    return new Promise((resolve, reject) => {
      let body = '';
      let tooLarge = false;
      request.setEncoding('utf8');
      request.on('data', chunk => {
        if (tooLarge) return;
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          tooLarge = true;
          body = '';
        }
      });
      request.on('end', () => {
        if (tooLarge) {
          reject(new ApiError(413, 'A solicitação excede o limite permitido.'));
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new ApiError(400, 'Envie um JSON válido.'));
        }
      });
      request.on('error', reject);
    });
  }

  function currentUser(request) {
    const cookie = request.headers.cookie || '';
    const token = cookie.split(';').map(part => part.trim())
      .find(part => part.startsWith(`${SESSION_COOKIE}=`))
      ?.slice(SESSION_COOKIE.length + 1);
    const session = token && sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(token);
      return undefined;
    }
    return store.users.find(user => user.id === session.userId);
  }

  function requireUser(request) {
    const user = currentUser(request);
    if (!user) throw new ApiError(401, 'Faça login para continuar.');
    return user;
  }

  function safeUser(user) {
    return { id: user.id, username: user.username, displayName: user.displayName };
  }

  function createSession(user, response) {
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
      userId: user.id,
      expiresAt: Date.now() + SESSION_MAX_AGE * 1000,
    });
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`,
    );
  }

  function validateUsername(value) {
    const username = typeof value === 'string' ? value.trim().replace(/^@/, '') : '';
    if (!USERNAME_PATTERN.test(username)) {
      throw new ApiError(400, 'Username deve ter de 3 a 20 caracteres (letras, números ou _).');
    }
    return username;
  }

  function findConversation(id, userId) {
    const conversation = store.conversations.find(item => item.id === id);
    if (!conversation || !conversation.participants.includes(userId)) {
      throw new ApiError(404, 'Conversa não encontrada.');
    }
    return conversation;
  }

  function conversationSummary(conversation, user) {
    const otherUser = conversation.isGroup
      ? null
      : store.users.find(item => item.id !== user.id && conversation.participants.includes(item.id));
    const lastMessage = conversation.messages.at(-1);
    return {
      id: conversation.id,
      isGroup: conversation.isGroup,
      name: conversation.isGroup ? conversation.name : otherUser.displayName,
      username: otherUser?.username || '',
      members: conversation.participants.length,
      lastMessage: lastMessage ? {
        text: lastMessage.text,
        senderUsername: store.users.find(item => item.id === lastMessage.senderId)?.username || '',
        time: lastMessage.time,
      } : null,
    };
  }

  async function handleApi(request, response, url) {
    const { pathname } = url;
    const method = request.method;

    if (method === 'POST' && pathname === '/api/register') {
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const displayName = typeof body.displayName === 'string'
        ? body.displayName.trim().slice(0, 40)
        : '';
      if (!displayName) throw new ApiError(400, 'Informe seu nome para exibição.');
      if (typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') < 8
        || Buffer.byteLength(body.password, 'utf8') > 128) {
        throw new ApiError(400, 'A senha deve ter entre 8 e 128 bytes.');
      }
      if (store.users.some(user => user.username.toLowerCase() === username.toLowerCase())) {
        throw new ApiError(409, 'Esse username já está em uso.');
      }
      const salt = randomBytes(16).toString('hex');
      const user = {
        id: randomUUID(),
        username,
        displayName,
        passwordSalt: salt,
        passwordHash: scryptSync(body.password, salt, 64).toString('hex'),
      };
      store.users.push(user);
      persist();
      createSession(user, response);
      sendJson(response, 201, { user: safeUser(user) });
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const user = store.users.find(item => item.username.toLowerCase() === username.toLowerCase());
      const password = typeof body.password === 'string' ? body.password : '';
      const candidate = scryptSync(password, user?.passwordSalt || 'zacord-invalid-user', 64);
      const valid = user
        && timingSafeEqual(candidate, Buffer.from(user.passwordHash, 'hex'));
      if (!valid) throw new ApiError(401, 'Username ou senha incorretos.');
      createSession(user, response);
      sendJson(response, 200, { user: safeUser(user) });
      return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const cookie = request.headers.cookie || '';
      const token = cookie.split(';').map(part => part.trim())
        .find(part => part.startsWith(`${SESSION_COOKIE}=`))
        ?.slice(SESSION_COOKIE.length + 1);
      if (token) sessions.delete(token);
      sendJson(response, 200, { ok: true }, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/me') {
      sendJson(response, 200, { user: safeUser(requireUser(request)) });
      return;
    }

    if (method === 'PATCH' && pathname === '/api/me') {
      const user = requireUser(request);
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const displayName = typeof body.displayName === 'string'
        ? body.displayName.trim().slice(0, 40)
        : '';
      if (!displayName) throw new ApiError(400, 'Informe seu nome para exibição.');
      if (store.users.some(item => item.id !== user.id
        && item.username.toLowerCase() === username.toLowerCase())) {
        throw new ApiError(409, 'Esse username já está em uso.');
      }
      user.username = username;
      user.displayName = displayName;
      persist();
      sendJson(response, 200, { user: safeUser(user) });
      return;
    }

    if (method === 'GET' && pathname === '/api/conversations') {
      const user = requireUser(request);
      const conversations = store.conversations
        .filter(item => item.participants.includes(user.id))
        .map(item => conversationSummary(item, user))
        .sort((a, b) => (b.lastMessage?.time || '').localeCompare(a.lastMessage?.time || ''));
      sendJson(response, 200, { conversations });
      return;
    }

    if (method === 'POST' && pathname === '/api/conversations') {
      const user = requireUser(request);
      const body = await readJson(request);
      const username = validateUsername(body.username);
      const recipient = store.users.find(item => item.username.toLowerCase() === username.toLowerCase());
      if (!recipient) throw new ApiError(404, 'Não encontramos esse username.');
      if (recipient.id === user.id) throw new ApiError(400, 'Você não pode iniciar uma conversa consigo.');
      let conversation = store.conversations.find(item => !item.isGroup
        && item.participants.length === 2
        && item.participants.includes(user.id)
        && item.participants.includes(recipient.id));
      if (!conversation) {
        conversation = {
          id: randomUUID(),
          isGroup: false,
          name: '',
          participants: [user.id, recipient.id],
          messages: [],
        };
        store.conversations.push(conversation);
        persist();
      }
      sendJson(response, 200, { conversation: conversationSummary(conversation, user) });
      return;
    }

    if (method === 'POST' && pathname === '/api/groups') {
      const user = requireUser(request);
      const body = await readJson(request);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) : '';
      if (!name) throw new ApiError(400, 'Informe o nome do grupo.');
      if (!Array.isArray(body.usernames) || body.usernames.length < 1 || body.usernames.length > 49) {
        throw new ApiError(400, 'Informe entre 1 e 49 participantes pelo username.');
      }
      const usernames = [...new Set(body.usernames.map(validateUsername)
        .map(username => username.toLowerCase()))];
      const participants = [user.id];
      for (const username of usernames) {
        const member = store.users.find(item => item.username.toLowerCase() === username);
        if (!member) throw new ApiError(404, `Não encontramos o username @${username}.`);
        if (!participants.includes(member.id)) participants.push(member.id);
      }
      if (participants.length < 2) throw new ApiError(400, 'Adicione ao menos outra pessoa ao grupo.');
      const conversation = {
        id: randomUUID(),
        isGroup: true,
        name,
        participants,
        messages: [],
      };
      store.conversations.push(conversation);
      persist();
      sendJson(response, 201, { conversation: conversationSummary(conversation, user) });
      return;
    }

    const messagesMatch = pathname.match(/^\/api\/conversations\/([a-f0-9-]+)\/messages$/i);
    if (messagesMatch && method === 'GET') {
      const user = requireUser(request);
      const conversation = findConversation(messagesMatch[1], user.id);
      const messages = conversation.messages.map(message => {
        const sender = store.users.find(item => item.id === message.senderId);
        return {
          id: message.id,
          text: message.text,
          username: sender?.username || '',
          displayName: sender?.displayName || 'Usuário',
          time: message.time,
        };
      });
      sendJson(response, 200, { messages });
      return;
    }

    if (messagesMatch && method === 'POST') {
      const user = requireUser(request);
      const conversation = findConversation(messagesMatch[1], user.id);
      const body = await readJson(request);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 2000) {
        throw new ApiError(400, 'A mensagem deve ter entre 1 e 2000 caracteres.');
      }
      const message = {
        id: randomUUID(),
        senderId: user.id,
        text,
        time: new Date().toISOString(),
      };
      conversation.messages.push(message);
      persist();
      sendJson(response, 201, {
        message: {
          id: message.id,
          text: message.text,
          username: user.username,
          displayName: user.displayName,
          time: message.time,
        },
      });
      return;
    }

    throw new ApiError(404, 'Endpoint não encontrado.');
  }

  function serveStatic(request, response, url) {
    let requested;
    try {
      requested = decodeURIComponent(url.pathname === '/' ? '/zacord_index.html' : url.pathname);
    } catch {
      throw new ApiError(400, 'Caminho inválido.');
    }
    const fileName = requested.replace(/^\/+/, '');
    if (!STATIC_FILES.has(fileName)) throw new ApiError(404, 'Arquivo não encontrado.');
    const filePath = path.join(ROOT, 'public', fileName);
    const contents = fs.readFileSync(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-cache',
      'Content-Length': contents.length,
      'Content-Type': CONTENT_TYPES[path.extname(filePath)],
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        serveStatic(request, response, url);
      } else {
        throw new ApiError(404, 'Endpoint não encontrado.');
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      if (error instanceof ApiError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error('Erro ao processar solicitação:', error);
      sendJson(response, 500, { error: 'Erro interno do servidor.' });
    }
  });

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.ZACORD_HOST || '127.0.0.1';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Zacord disponível em http://${host}:${port}`);
  });
}

export { createServer };
