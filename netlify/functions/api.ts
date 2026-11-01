import type { Config } from "@netlify/functions";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { conversations, messages, participants, sessions, users } from "../../db/schema.js";

const SESSION_COOKIE = "zacord_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type User = typeof users.$inferSelect;

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(status: number, value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

async function readJson(request: Request): Promise<any> {
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new ApiError(413, "A solicitação excede o limite permitido.");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new ApiError(400, "Envie um JSON válido.");
  }
}

function sessionToken(request: Request) {
  const cookie = request.headers.get("cookie") || "";
  return cookie.split(";").map(part => part.trim())
    .find(part => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}

async function currentUser(request: Request): Promise<User | undefined> {
  const token = sessionToken(request);
  if (!token) return undefined;
  const [row] = await db.select({ user: users }).from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())));
  return row?.user;
}

async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) throw new ApiError(401, "Faça login para continuar.");
  return user;
}

function safeUser(user: User) {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

async function createSession(user: User) {
  const token = randomBytes(32).toString("hex");
  await db.insert(sessions).values({
    token,
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE * 1000),
  });
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

function validateUsername(value: unknown) {
  const username = typeof value === "string" ? value.trim().replace(/^@/, "") : "";
  if (!USERNAME_PATTERN.test(username)) {
    throw new ApiError(400, "Username deve ter de 3 a 20 caracteres (letras, números ou _).");
  }
  return username;
}

function validateDisplayName(value: unknown) {
  const displayName = typeof value === "string" ? value.trim().slice(0, 40) : "";
  if (!displayName) throw new ApiError(400, "Informe seu nome para exibição.");
  return displayName;
}

async function findUserByUsername(username: string) {
  const [user] = await db.select().from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`);
  return user;
}

async function findConversation(id: string, userId: string) {
  if (!UUID_PATTERN.test(id)) throw new ApiError(404, "Conversa não encontrada.");
  const [row] = await db.select({ conversation: conversations }).from(conversations)
    .innerJoin(participants, eq(participants.conversationId, conversations.id))
    .where(and(eq(conversations.id, id), eq(participants.userId, userId)));
  if (!row) throw new ApiError(404, "Conversa não encontrada.");
  return row.conversation;
}

async function conversationSummary(conversation: typeof conversations.$inferSelect, user: User) {
  const members = await db.select({ user: users }).from(participants)
    .innerJoin(users, eq(users.id, participants.userId))
    .where(eq(participants.conversationId, conversation.id));
  const otherUser = conversation.isGroup
    ? null
    : members.map(item => item.user).find(item => item.id !== user.id);
  const [lastMessage] = await db.select({ text: messages.text, senderUsername: users.username, time: messages.createdAt })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(desc(messages.createdAt))
    .limit(1);
  return {
    id: conversation.id,
    isGroup: conversation.isGroup,
    name: conversation.isGroup ? conversation.name : otherUser?.displayName || "Usuário",
    username: otherUser?.username || "",
    members: members.length,
    lastMessage: lastMessage ? { ...lastMessage, time: lastMessage.time.toISOString() } : null,
  };
}

function hashPassword(password: string, salt: string) {
  return scryptSync(password, salt, 64);
}

async function handleApi(request: Request) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === "POST" && pathname === "/api/register") {
    const body = await readJson(request);
    const username = validateUsername(body.username);
    const displayName = validateDisplayName(body.displayName);
    if (typeof body.password !== "string" || Buffer.byteLength(body.password, "utf8") < 8
      || Buffer.byteLength(body.password, "utf8") > 128) {
      throw new ApiError(400, "A senha deve ter entre 8 e 128 bytes.");
    }
    if (await findUserByUsername(username)) throw new ApiError(409, "Esse username já está em uso.");
    const salt = randomBytes(16).toString("hex");
    const [user] = await db.insert(users).values({
      username,
      displayName,
      passwordSalt: salt,
      passwordHash: hashPassword(body.password, salt).toString("hex"),
    }).returning();
    return json(201, { user: safeUser(user) }, { "Set-Cookie": await createSession(user) });
  }

  if (method === "POST" && pathname === "/api/login") {
    const body = await readJson(request);
    const username = validateUsername(body.username);
    const user = await findUserByUsername(username);
    const password = typeof body.password === "string" ? body.password : "";
    const candidate = hashPassword(password, user?.passwordSalt || "zacord-invalid-user");
    const valid = user && timingSafeEqual(candidate, Buffer.from(user.passwordHash, "hex"));
    if (!valid) throw new ApiError(401, "Username ou senha incorretos.");
    return json(200, { user: safeUser(user) }, { "Set-Cookie": await createSession(user) });
  }

  if (method === "POST" && pathname === "/api/logout") {
    const token = sessionToken(request);
    if (token) await db.delete(sessions).where(eq(sessions.token, token));
    return json(200, { ok: true }, {
      "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    });
  }

  if (method === "GET" && pathname === "/api/me") {
    return json(200, { user: safeUser(await requireUser(request)) });
  }

  if (method === "PATCH" && pathname === "/api/me") {
    const user = await requireUser(request);
    const body = await readJson(request);
    const username = validateUsername(body.username);
    const displayName = validateDisplayName(body.displayName);
    const existing = await findUserByUsername(username);
    if (existing && existing.id !== user.id) throw new ApiError(409, "Esse username já está em uso.");
    const [updated] = await db.update(users).set({ username, displayName })
      .where(eq(users.id, user.id)).returning();
    return json(200, { user: safeUser(updated) });
  }

  if (method === "GET" && pathname === "/api/conversations") {
    const user = await requireUser(request);
    const rows = await db.select({ conversation: conversations }).from(conversations)
      .innerJoin(participants, eq(participants.conversationId, conversations.id))
      .where(eq(participants.userId, user.id));
    const list = await Promise.all(rows.map(row => conversationSummary(row.conversation, user)));
    list.sort((a, b) => (b.lastMessage?.time || "").localeCompare(a.lastMessage?.time || ""));
    return json(200, { conversations: list });
  }

  if (method === "POST" && pathname === "/api/conversations") {
    const user = await requireUser(request);
    const body = await readJson(request);
    const recipient = await findUserByUsername(validateUsername(body.username));
    if (!recipient) throw new ApiError(404, "Não encontramos esse username.");
    if (recipient.id === user.id) throw new ApiError(400, "Você não pode iniciar uma conversa consigo.");
    const mine = db.select({ id: participants.conversationId }).from(participants)
      .where(eq(participants.userId, user.id));
    const [existing] = await db.select({ conversation: conversations }).from(conversations)
      .innerJoin(participants, eq(participants.conversationId, conversations.id))
      .where(and(
        eq(conversations.isGroup, false),
        eq(participants.userId, recipient.id),
        inArray(conversations.id, mine),
      ))
      .limit(1);
    let conversation = existing?.conversation;
    if (!conversation) {
      [conversation] = await db.insert(conversations).values({ isGroup: false, name: "" }).returning();
      await db.insert(participants).values([
        { conversationId: conversation.id, userId: user.id },
        { conversationId: conversation.id, userId: recipient.id },
      ]);
    }
    return json(200, { conversation: await conversationSummary(conversation, user) });
  }

  if (method === "POST" && pathname === "/api/groups") {
    const user = await requireUser(request);
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
    if (!name) throw new ApiError(400, "Informe o nome do grupo.");
    if (!Array.isArray(body.usernames) || body.usernames.length < 1 || body.usernames.length > 49) {
      throw new ApiError(400, "Informe entre 1 e 49 participantes pelo username.");
    }
    const usernames = [...new Set(body.usernames.map(validateUsername)
      .map((username: string) => username.toLowerCase()))] as string[];
    const memberIds = [user.id];
    for (const username of usernames) {
      const member = await findUserByUsername(username);
      if (!member) throw new ApiError(404, `Não encontramos o username @${username}.`);
      if (!memberIds.includes(member.id)) memberIds.push(member.id);
    }
    if (memberIds.length < 2) throw new ApiError(400, "Adicione ao menos outra pessoa ao grupo.");
    const [conversation] = await db.insert(conversations).values({ isGroup: true, name }).returning();
    await db.insert(participants).values(memberIds.map(userId => ({ conversationId: conversation.id, userId })));
    return json(201, { conversation: await conversationSummary(conversation, user) });
  }

  const messagesMatch = pathname.match(/^\/api\/conversations\/([a-f0-9-]+)\/messages$/i);
  if (messagesMatch && method === "GET") {
    const user = await requireUser(request);
    const conversation = await findConversation(messagesMatch[1], user.id);
    const rows = await db.select({
      id: messages.id,
      text: messages.text,
      username: users.username,
      displayName: users.displayName,
      time: messages.createdAt,
    }).from(messages)
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(eq(messages.conversationId, conversation.id))
      .orderBy(asc(messages.createdAt));
    return json(200, { messages: rows.map(row => ({ ...row, time: row.time.toISOString() })) });
  }

  if (messagesMatch && method === "POST") {
    const user = await requireUser(request);
    const conversation = await findConversation(messagesMatch[1], user.id);
    const body = await readJson(request);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 2000) {
      throw new ApiError(400, "A mensagem deve ter entre 1 e 2000 caracteres.");
    }
    const [message] = await db.insert(messages)
      .values({ conversationId: conversation.id, senderId: user.id, text })
      .returning();
    return json(201, {
      message: {
        id: message.id,
        text: message.text,
        username: user.username,
        displayName: user.displayName,
        time: message.createdAt.toISOString(),
      },
    });
  }

  throw new ApiError(404, "Endpoint não encontrado.");
}

export default async (request: Request) => {
  try {
    return await handleApi(request);
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, { error: error.message });
    console.error("Erro ao processar solicitação:", error);
    return json(500, { error: "Erro interno do servidor." });
  }
};

export const config: Config = {
  path: "/api/*",
};
