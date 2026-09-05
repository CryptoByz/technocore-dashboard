/**
 * tclk & A2A Event Tagging Engine
 */

function parseA2AEvent(msg, roomName = '') {
  const text = msg.text || '';
  const from = msg.from || '';
  const isDid = from.startsWith('did:key:');

  let dealType = 'GENERAL_A2A';
  let statusBadge = '🔄 ACTIVE';
  let badgeColor = '#06b6d4'; // cyan
  let summary = text;

  // 1. HTLC / Settlement Detection
  if (/Hash time-locked contract executed/i.test(text) || /htlc.*locked/i.test(text) || /terms locked/i.test(text)) {
    dealType = 'HTLC_LOCKED';
    statusBadge = '🔒 LOCKED';
    badgeColor = '#eab308'; // amber
  } else if (/Secret pre-image verified/i.test(text) || /Token settlement complete/i.test(text) || /settled/i.test(text) || /claimed/i.test(text)) {
    dealType = 'HTLC_SETTLED';
    statusBadge = '✅ SETTLED';
    badgeColor = '#10b981'; // emerald
  } else if (/refund/i.test(text) || /timeout reclaim/i.test(text)) {
    dealType = 'HTLC_REFUNDED';
    statusBadge = '↩ REFUNDED';
    badgeColor = '#f43f5e'; // rose
  } else if (/offer/i.test(text) || /accept/i.test(text) || /propose/i.test(text)) {
    dealType = 'HTLC_OFFER';
    statusBadge = '📝 OFFER';
    badgeColor = '#8b5cf6'; // purple
  } else if (/JOB → CLAIM → RESULT → ATTEST/i.test(text) || /kibble/i.test(text) || /Useful-work/i.test(text)) {
    dealType = 'KIBBLE_TASK';
    statusBadge = '⚡ TASK WORK';
    badgeColor = '#3b82f6'; // blue
  } else if (/Active session initialized/i.test(text) || /A2A Peer ACK/i.test(text) || /model_weight/i.test(text)) {
    dealType = 'SESSION_INIT';
    statusBadge = '📡 PEER ACK';
    badgeColor = '#06b6d4'; // cyan
  }

  // Extract Node/Session ID if present [NODE-XXXXX] or [69A22B]
  const nodeMatch = text.match(/\[([A-Z0-9_-]+)\]/i);
  const nodeId = nodeMatch ? nodeMatch[1] : null;

  return {
    seq: msg.seq,
    ts: msg.ts,
    room: roomName,
    from,
    shortFrom: isDid ? `${from.slice(0, 12)}...${from.slice(-6)}` : `~${from}`,
    isDid,
    text,
    dealType,
    statusBadge,
    badgeColor,
    nodeId,
    sig: msg.sig || null,
    nonce: msg.nonce || null
  };
}

module.exports = {
  parseA2AEvent
};
