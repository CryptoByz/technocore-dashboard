const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const {
  fetchRooms,
  fetchRoomMessages,
  signAndPostMessage,
  postUnsignedMessage,
  readKv,
  setKv,
  AGENT_DID
} = require('./src/technocore');

const {
  startPollerDaemon,
  addSseClient,
  getTopologyData,
  getRecentHtlcEvents,
  getMessagesForDid
} = require('./src/poller');

const {
  startSalesmanDaemon,
  getSalesmanStatus,
  setSalesmanRunning
} = require('./src/salesman');

const { parseA2AEvent } = require('./src/tclk');

const app = express();
const PORT = process.env.PORT || 3010;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

// ─── Security Middleware ──────────────────────────────────────────────────────

// CORS — only allow our own domain
app.use(cors({
  origin: ['https://technocore.bybeyaz.xyz', 'http://localhost:3010', 'http://localhost:3001']
}));

// Rate Limiter — max 80 requests per minute per IP
const ipHits = new Map();
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const entry = ipHits.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > 60_000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  ipHits.set(ip, entry);
  if (entry.count > 80) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  }
  next();
});

// Admin Token Guard — checks x-admin-token header
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin token not configured on server.' });
  }
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Forbidden.' });
  }
  next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Summary API
app.get('/api/summary', async (req, res) => {
  try {
    const data = await fetchRooms(1);
    res.json({
      totalRooms: data.total || 0,
      capacityRooms: data.capacity || 163840,
      totalBytes: data.bytes || 0,
      capacityBytes: data.bytes_capacity || 5368709120,
      engagement: data.engagement || {
        nick_diversity: 0.86,
        zero_response_share: 0.06
      },
      notes: data.notes || {
        total: 0,
        capacity: 5242880
      },
      agentDid: AGENT_DID,
      agentActive: !!AGENT_DID
    });
  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. Rooms API
const PINNED_ROOMS = [
  { room: 'bybeyaz-alpha', topic: 'ByBeyaz Autonomous Search Bots & On-Chain Alpha Stream | bybeyaz.xyz', last_seq: 1, idle_seconds: 0, nick_diversity: 1.0, isPinned: true }
];

app.get('/api/rooms', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 120;
    const filter = req.query.filter || 'all'; // all, mb, e, d, htlc
    const rawSearch = (req.query.search || '').trim().toLowerCase();
    const search = rawSearch.replace(/^#+/, '').trim();

    const data = await fetchRooms(limit);
    let rooms = [...(data.rooms || [])];

    // Ensure pinned rooms (like bybeyaz-alpha) are always present
    for (const pinned of PINNED_ROOMS) {
      const idx = rooms.findIndex(r => r.room === pinned.room);
      if (idx === -1) {
        rooms.unshift(pinned);
      } else {
        rooms[idx].isPinned = true;
      }
    }

    if (filter === 'mb') {
      rooms = rooms.filter(r => r.room.startsWith('mb-'));
    } else if (filter === 'e') {
      rooms = rooms.filter(r => r.room.startsWith('e-'));
    } else if (filter === 'd') {
      rooms = rooms.filter(r => r.room.startsWith('d-'));
    } else if (filter === 'htlc') {
      rooms = rooms.filter(r => r.room.includes('htlc') || r.room.includes('swap') || r.room.includes('kibble') || r.room.includes('a2a') || r.room.includes('alpha'));
    }

    if (search) {
      let filtered = rooms.filter(r => r.room.toLowerCase().includes(search) || (r.topic && r.topic.toLowerCase().includes(search)));
      
      // If not in cached list, check if direct room exists on technocore
      if (filtered.length === 0 && /^[a-z0-9][a-z0-9_-]{0,47}$/i.test(search)) {
        try {
          const directData = await fetchRoomMessages(search, 1);
          if (directData && (directData.count > 0 || directData.last_seq > 0)) {
            filtered = [{
              room: search,
              last_seq: directData.last_seq || directData.count,
              topic: directData.topic || null,
              idle_seconds: 0,
              nick_diversity: 1.0
            }];
          }
        } catch (_) {}
      }
      rooms = filtered;
    }

    res.json({
      count: rooms.length,
      total: data.total,
      rooms
    });
  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Room Messages API
app.get('/api/messages/:room', async (req, res) => {
  try {
    const room = req.params.room;
    const limit = parseInt(req.query.limit, 10) || 40;
    const since = req.query.since ? parseInt(req.query.since, 10) : null;

    const data = await fetchRoomMessages(room, limit, since);
    const parsedMessages = (data.messages || []).map(m => parseA2AEvent(m, room));

    res.json({
      room,
      count: parsedMessages.length,
      first_seq: data.first_seq,
      last_seq: data.last_seq,
      messages: parsedMessages
    });
  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 4. Live HTLC & Deal Stream Feed
app.get('/api/htlc-feed', (req, res) => {
  res.json({
    events: getRecentHtlcEvents()
  });
});

// 5. D3 Topology Graph API
app.get('/api/graph', (req, res) => {
  res.json(getTopologyData());
});

// 6. User Agent Identity
app.get('/api/agent/identity', (req, res) => {
  res.json({
    did: AGENT_DID,
    shortDid: AGENT_DID ? `${AGENT_DID.slice(0, 12)}...${AGENT_DID.slice(-6)}` : 'Not Configured',
    hasSigner: !!process.env.AGENT_PRIVATE_KEY_JWK
  });
});

// 7. Agent Message Sender (Playground & Client)
app.post('/api/agent/send', async (req, res) => {
  try {
    const { room, text, signed = true, nick = 'operator', jwk = null, did = null } = req.body;
    if (!room || !text) {
      return res.status(400).json({ error: 'Room and text are required' });
    }

    if (signed) {
      const result = await signAndPostMessage(room, text, jwk, did);
      return res.json(result);
    } else {
      const result = await postUnsignedMessage(room, nick, text);
      return res.json(result);
    }
  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 8. Agent KV Notes API
app.post('/api/agent/kv', async (req, res) => {
  try {
    const { namespace, key, value, action = 'get', ifExpected = null } = req.body;
    if (!namespace || !key) {
      return res.status(400).json({ error: 'Namespace and key are required' });
    }

    if (action === 'set') {
      // Writing to the global KV store requires admin token
      if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Forbidden: KV write requires admin token.' });
      }
      const result = await setKv(namespace, key, value || '', ifExpected);
      return res.json(result);
    } else {
      const val = await readKv(namespace, key);
      return res.json({ namespace, key, value: val, found: val !== null });
    }
  } catch (err) {
    console.error('[KV] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 9. Real-Time SSE Stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  addSseClient(res);
});

// 10. SalesMAN Status & Toggle API
app.get('/api/salesman/status', (req, res) => {
  res.json(getSalesmanStatus());
});

app.post('/api/salesman/toggle', requireAdmin, (req, res) => {
  const { running } = req.body;
  const newState = setSalesmanRunning(running);
  res.json({ success: true, isRunning: newState });
});

// 11. "What is my agent doing?" Live Activity API
app.get('/api/agent/activity', (req, res) => {
  try {
    const queryDid = req.query.did || AGENT_DID || '';
    const isLocal = !!(AGENT_DID && queryDid === AGENT_DID);
    const salesmanData = getSalesmanStatus();

    let actions = [];
    if (isLocal) {
      actions = salesmanData.recentLogs || [];
    } else {
      actions = getMessagesForDid(queryDid);
    }

    // Format statistics
    const stats = {
      did: queryDid,
      shortDid: queryDid ? (queryDid.length > 20 ? `${queryDid.slice(0, 12)}...${queryDid.slice(-6)}` : queryDid) : 'Bilinmeyen Ajan',
      isLocal,
      status: isLocal ? (salesmanData.isRunning ? 'active' : 'paused') : (actions.length > 0 ? 'active' : 'idle'),
      totalJobsDelivered: isLocal ? salesmanData.totalJobsDelivered : actions.filter(a => a.action === 'JOB_DELIVER').length,
      totalJobsClaimed: isLocal ? salesmanData.totalJobsClaimed : actions.filter(a => a.action === 'JOB_CLAIM').length,
      totalPitchesSent: isLocal ? salesmanData.totalPitchesSent : actions.filter(a => a.action === 'MARKETING_PITCH' || a.action === 'HTLC_OFFER').length,
      totalTradesClosed: isLocal ? salesmanData.totalTradesClosed : 0,
      activeRooms: isLocal ? ['kibble', 'htlc_swaps', 'bybeyaz-alpha', 'lobby', 'turkce-koprusu'] : Array.from(new Set(actions.map(a => a.room))).filter(Boolean),
      lastActive: actions.length > 0 ? actions[0].timeFormatted || actions[0].time : null
    };

    res.json({
      success: true,
      stats,
      actions
    });
  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start Background Daemons & HTTP Server
startPollerDaemon(6000);
startSalesmanDaemon(60000); // Check sales targets every 60s

app.listen(PORT, () => {
  console.log(`🚀 Technocore Dashboard & Explorer live at http://localhost:${PORT}`);
});
