const { fetchRoomMessages, fetchRooms } = require('./technocore');
const { parseA2AEvent } = require('./tclk');

const WATCHED_ROOMS = [
  'bybeyaz-alpha',
  'htlc_swaps',
  'lobby',
  'kibble',
  'turkce-koprusu',
  'a2a_mesh_telemetry',
  'validators',
  'zk_rollups',
  'technocore'
];

// In-Memory Storage
let recentHtlcEvents = [];
const lastSeqMap = new Map();
const nodeSet = new Map(); // id -> { id, label, type: 'did'|'nick'|'room', messageCount, lastSeen }
const linkMap = new Map(); // "source-target" -> { source, target, weight, lastSeen }

// SSE Clients
const sseClients = new Set();

function addSseClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

function broadcastSse(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

async function pollRooms() {
  for (const room of WATCHED_ROOMS) {
    try {
      await new Promise(r => setTimeout(r, 500));
      const lastSeq = lastSeqMap.get(room);
      const data = await fetchRoomMessages(room, 20, lastSeq ? lastSeq : null);
      
      if (data && data.messages && data.messages.length > 0) {
        const highestSeq = Math.max(...data.messages.map(m => m.seq || 0));
        lastSeqMap.set(room, highestSeq);

        // Add room node to topology
        if (!nodeSet.has(room)) {
          nodeSet.set(room, {
            id: room,
            label: `#${room}`,
            type: 'room',
            messageCount: 0,
            lastSeen: Date.now()
          });
        }
        const roomNode = nodeSet.get(room);
        roomNode.messageCount += data.messages.length;
        roomNode.lastSeen = Date.now();

        for (const rawMsg of data.messages) {
          const parsed = parseA2AEvent(rawMsg, room);
          
          // If message is in HTLC or financial room, or has a special deal tag
          if (room === 'htlc_swaps' || room === 'kibble' || parsed.dealType !== 'GENERAL_A2A') {
            // Avoid duplicate events
            if (!recentHtlcEvents.some(e => e.seq === parsed.seq && e.room === room)) {
              recentHtlcEvents.unshift(parsed);
              if (recentHtlcEvents.length > 100) recentHtlcEvents.pop();

              broadcastSse('htlc_event', parsed);
            }
          }

          // Topology Graph Node & Link Update
          const fromId = parsed.from || 'anonymous';
          const isDid = parsed.isDid;

          if (!nodeSet.has(fromId)) {
            nodeSet.set(fromId, {
              id: fromId,
              label: parsed.shortFrom,
              type: isDid ? 'did' : 'nick',
              messageCount: 1,
              lastSeen: Date.now()
            });
          } else {
            const agentNode = nodeSet.get(fromId);
            agentNode.messageCount += 1;
            agentNode.lastSeen = Date.now();
          }

          // Link: Agent -> Room
          const linkKey = `${fromId}->${room}`;
          if (!linkMap.has(linkKey)) {
            linkMap.set(linkKey, {
              source: fromId,
              target: room,
              weight: 1,
              lastSeen: Date.now()
            });
          } else {
            const l = linkMap.get(linkKey);
            l.weight += 1;
            l.lastSeen = Date.now();
          }

          // Buffer message for DID activity explorer
          recentAllMessages.unshift(parsed);
          if (recentAllMessages.length > 300) recentAllMessages.pop();
        }
      }
    } catch (err) {
      // Graceful poll failure
    }
  }

  // Cleanup nodes inactive for > 2 hours to keep topology light
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
  for (const [key, node] of nodeSet.entries()) {
    if (node.type !== 'room' && node.lastSeen < twoHoursAgo) {
      nodeSet.delete(key);
    }
  }
}

let recentAllMessages = [];

function getMessagesForDid(did) {
  if (!did) return [];
  return recentAllMessages
    .filter(m => m.from === did || (m.author && m.author.did === did))
    .slice(0, 50)
    .map(m => ({
      id: 'net_' + (m.seq || Date.now()) + '_' + (m.room || 'gen'),
      time: m.time || new Date().toISOString(),
      timeFormatted: m.time ? new Date(m.time).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : new Date().toLocaleTimeString('tr-TR'),
      action: m.dealType === 'JOB_CLAIM' ? 'JOB_CLAIM' : (m.dealType === 'JOB_DELIVER' ? 'JOB_DELIVER' : (m.dealType === 'HTLC_OFFER' ? 'HTLC_OFFER' : 'SIGNED_MESSAGE')),
      room: m.room,
      text: m.text,
      title: m.dealTitle || (m.text ? m.text.slice(0, 60) : 'Signed Message'),
      // The signature is not verified anywhere in this project - no crypto.verify call exists -
      // so labelling these rows "VERIFIED" asserted a guarantee the code does not make. The
      // status now says what is actually true: the upstream reported the message as signed.
      status: 'SIGNED (unverified)'
    }));
}

function getTopologyData() {
  // Always include room nodes
  const roomNodes = Array.from(nodeSet.values()).filter(n => n.type === 'room');
  
  // Pick top 45 most active agents (prioritize did:key and highest message count)
  const agentNodes = Array.from(nodeSet.values())
    .filter(n => n.type !== 'room')
    .sort((a, b) => (b.messageCount + (b.type === 'did' ? 10 : 0)) - (a.messageCount + (a.type === 'did' ? 10 : 0)))
    .slice(0, 45);

  const activeNodeMap = new Set([...roomNodes, ...agentNodes].map(n => n.id));

  const nodes = [...roomNodes, ...agentNodes].map(n => ({
    id: n.id,
    label: n.label,
    type: n.type,
    size: n.type === 'room' ? Math.min(22, 12 + Math.log2(n.messageCount + 1) * 2.5) : (n.type === 'did' ? 9 : 7),
    color: n.type === 'room' ? '#3b82f6' : (n.type === 'did' ? '#10b981' : '#9ca3af')
  }));

  const links = Array.from(linkMap.values())
    .filter(l => activeNodeMap.has(l.source) && activeNodeMap.has(l.target))
    .slice(0, 75)
    .map(l => ({
      source: l.source,
      target: l.target,
      weight: l.weight
    }));

  return { nodes, links };
}

function getRecentHtlcEvents() {
  return recentHtlcEvents;
}

function startPollerDaemon(intervalMs = 6000) {
  console.log('🚀 Technocore Network Poller & Topology Engine Started.');
  pollRooms();
  setInterval(pollRooms, intervalMs);
}

module.exports = {
  startPollerDaemon,
  addSseClient,
  getTopologyData,
  getRecentHtlcEvents,
  getMessagesForDid
};
