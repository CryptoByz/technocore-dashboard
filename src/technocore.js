const crypto = require('crypto');
require('dotenv').config();

const BASE_URL = process.env.TECHNOCORE_BASE_URL || 'https://technocore.chat';
const AGENT_DID = process.env.AGENT_DID || '';
let agentPrivateKey = null;

if (process.env.AGENT_PRIVATE_KEY_JWK) {
  try {
    const jwk = JSON.parse(process.env.AGENT_PRIVATE_KEY_JWK);
    agentPrivateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    console.error('[Technocore] Failed to parse AGENT_PRIVATE_KEY_JWK:', err.message);
  }
}

// In-Memory Caches
let cachedRooms = null;
let lastRoomsFetch = 0;
const ROOMS_CACHE_TTL = 15000; // 15 seconds

async function fetchRooms(limit = 100) {
  const now = Date.now();
  if (cachedRooms && (now - lastRoomsFetch < ROOMS_CACHE_TTL)) {
    return cachedRooms;
  }

  try {
    const res = await fetch(`${BASE_URL}/rooms?format=json&limit=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cachedRooms = data;
    lastRoomsFetch = now;
    return data;
  } catch (err) {
    console.error('[Technocore] Error fetching rooms:', err.message);
    return cachedRooms || { rooms: [], total: 0, capacity: 163840 };
  }
}

async function fetchRoomMessages(room, limit = 50, since = null, wait = null) {
  try {
    let url = `${BASE_URL}/r/${encodeURIComponent(room)}?format=json&limit=${limit}`;
    if (since !== null && since !== undefined) url += `&since=${since}`;
    if (wait !== null && wait !== undefined) url += `&wait=${wait}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`[Technocore] Error fetching messages for room ${room}:`, err.message);
    return { room, count: 0, messages: [] };
  }
}

// Signs with the server's own agent identity only.
//
// This function used to accept a caller-supplied JWK and DID, which meant any client could have
// the server sign a message under an arbitrary identity - impersonation, and an injection point
// for arbitrary private-key material through createPrivateKey. The key and DID are resolved
// from the environment, never from a caller.
async function signAndPostMessage(room, text) {
  const activeKey = agentPrivateKey;
  const activeDid = AGENT_DID;

  if (!activeKey || !activeDid) {
    throw new Error('Ajan kimliği veya private key bulunamadı. Lütfen .json dosyanızla giriş yapın.');
  }

  // Single line text cleanup as required by Technocore
  const cleanText = text.replace(/[\r\n\t]+/g, ' ').trim();
  if (!cleanText) throw new Error('Message text cannot be empty');

  // Nonce must be monotonic and strictly increasing
  const nonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const payload = Buffer.from(`${room}|${nonce}|${cleanText}`, 'utf8');
  const sig = crypto.sign(null, payload, activeKey).toString('base64url');

  const url = `${BASE_URL}/r/${encodeURIComponent(room)}/say-signed/${encodeURIComponent(activeDid)}/${encodeURIComponent(sig)}/${nonce}/${encodeURIComponent(cleanText)}`;
  
  const res = await fetch(url);
  const respText = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    response: respText,
    nonce,
    did: activeDid,
    text: cleanText
  };
}

async function postUnsignedMessage(room, nick, text) {
  const cleanNick = (nick || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
  const cleanText = text.replace(/[\r\n\t]+/g, ' ').trim();
  const url = `${BASE_URL}/r/${encodeURIComponent(room)}/say/${encodeURIComponent(cleanNick)}/${encodeURIComponent(cleanText)}`;

  const res = await fetch(url);
  const respText = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    response: respText,
    from: cleanNick,
    text: cleanText
  };
}

async function readKv(namespace, key) {
  try {
    const res = await fetch(`${BASE_URL}/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    return await res.text();
  } catch (err) {
    return null;
  }
}

async function setKv(namespace, key, value, ifExpected = null) {
  let url = `${BASE_URL}/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}/set/${encodeURIComponent(value)}`;
  if (ifExpected !== null) url += `?if=${encodeURIComponent(ifExpected)}`;
  
  const res = await fetch(url);
  return {
    ok: res.ok,
    status: res.status,
    response: await res.text()
  };
}

module.exports = {
  fetchRooms,
  fetchRoomMessages,
  signAndPostMessage,
  postUnsignedMessage,
  readKv,
  setKv,
  AGENT_DID,
  BASE_URL
};
