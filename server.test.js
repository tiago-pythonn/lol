import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from './server.js';

async function startServer(dataFile) {
  const server = createServer({ dataFile });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function request(baseUrl, route, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  return {
    response,
    value,
    cookie: response.headers.get('Set-Cookie')?.split(';')[0],
  };
}

test('users can exchange messages and conversations persist after restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zacord-test-'));
  const dataFile = path.join(directory, 'data.json');
  let running = await startServer(dataFile);
  t.after(async () => {
    await running.close();
    if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
    fs.rmdirSync(directory);
  });

  assert.equal((await fetch(`${running.baseUrl}/`)).status, 200);
  const alice = await request(running.baseUrl, '/api/register', {
    method: 'POST',
    body: { displayName: 'Alice', username: 'alice', password: 'password-a' },
  });
  const bob = await request(running.baseUrl, '/api/register', {
    method: 'POST',
    body: { displayName: 'Bob', username: 'bob', password: 'password-b' },
  });
  assert.equal(alice.response.status, 201);
  assert.equal(bob.response.status, 201);

  const { response: conversationResponse, value: conversationResult } = await request(
    running.baseUrl,
    '/api/conversations',
    { method: 'POST', body: { username: 'bob' }, cookie: alice.cookie },
  );
  assert.equal(conversationResponse.status, 200);
  const conversationId = conversationResult.conversation.id;
  const sent = await request(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { text: 'Olá, Bob!' },
    cookie: alice.cookie,
  });
  assert.equal(sent.response.status, 201);

  const inbox = await request(
    running.baseUrl,
    `/api/conversations/${conversationId}/messages`,
    { cookie: bob.cookie },
  );
  assert.equal(inbox.value.messages[0].text, 'Olá, Bob!');
  assert.equal(inbox.value.messages[0].username, 'alice');

  const group = await request(running.baseUrl, '/api/groups', {
    method: 'POST',
    body: { name: 'Amigos', usernames: ['bob'] },
    cookie: alice.cookie,
  });
  assert.equal(group.response.status, 201);
  const bobConversations = await request(running.baseUrl, '/api/conversations', {
    cookie: bob.cookie,
  });
  assert.equal(bobConversations.value.conversations.length, 2);

  const invalidLogin = await request(running.baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'alice', password: 'incorrect' },
  });
  assert.equal(invalidLogin.response.status, 401);
  assert.equal((await request(running.baseUrl, '/api/conversations')).response.status, 401);

  await running.close();
  running = await startServer(dataFile);
  const login = await request(running.baseUrl, '/api/login', {
    method: 'POST',
    body: { username: 'alice', password: 'password-a' },
  });
  assert.equal(login.response.status, 200);
  const persisted = await request(running.baseUrl, '/api/conversations', {
    cookie: login.cookie,
  });
  assert.equal(persisted.value.conversations.length, 2);
});
