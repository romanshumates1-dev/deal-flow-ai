/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          DealFlow AI — Production Backend  v2.0                 ║
 * ║   Node.js + Express + Twilio SMS + Anthropic Claude             ║
 * ║   Handles: Seller outreach, negotiation, buyer pitching,        ║
 * ║            assignment contracts, follow-ups, webhook routing     ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */
'use strict';

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const fs         = require('fs');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ─────────────────────────────────────────────
   MIDDLEWARE
───────────────────────────────────────────── */
app.use(cors({ origin: '*' }));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: false })); // Twilio webhooks are URL-encoded
// Serve frontend HTML if in same directory
app.use(express.static(path.join(__dirname)));

/* ─────────────────────────────────────────────
   RUNTIME CONFIGURATION
   Credentials can be set via .env OR via the
   /api/settings endpoint at runtime.
───────────────────────────────────────────── */
let CFG = {
  TWILIO_SID:          process.env.TWILIO_ACCOUNT_SID  || '',
  TWILIO_TOKEN:        process.env.TWILIO_AUTH_TOKEN    || '',
  TWILIO_FROM:         process.env.TWILIO_FROM_NUMBER   || '',
  ANTHROPIC_KEY:       process.env.ANTHROPIC_API_KEY    || '',
  AI_PERSONA:          process.env.AI_PERSONA           || 'Alex',
  COMPANY_NAME:        process.env.COMPANY_NAME         || 'HomeFlex Acquisitions',
  MSG_TONE:            process.env.MSG_TONE             || 'professional',
  MAX_FOLLOWUPS:       parseInt(process.env.MAX_FOLLOWUPS       || '5'),
  FOLLOWUP_DELAY_MS:   parseInt(process.env.FOLLOWUP_DELAY_HOURS || '24') * 3_600_000,
};

const isProduction = () =>
  !!(CFG.TWILIO_SID && CFG.TWILIO_TOKEN && CFG.TWILIO_FROM && CFG.ANTHROPIC_KEY);

/* Lazy-create SDK clients so credentials can be set at runtime */
const getTwilio = () => {
  if (!CFG.TWILIO_SID || !CFG.TWILIO_TOKEN) return null;
  const twilio = require('twilio');
  return twilio(CFG.TWILIO_SID, CFG.TWILIO_TOKEN);
};
const getAnthropic = () => {
  if (!CFG.ANTHROPIC_KEY) return null;
  const { default: Anthropic } = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: CFG.ANTHROPIC_KEY });
};

/* ─────────────────────────────────────────────
   STATE — in-memory, auto-saved to JSON
───────────────────────────────────────────── */
const STATE_FILE = path.join(__dirname, 'dealflow_state.json');

let STATE = {
  sellers:       {},   // id → Seller
  buyers:        {},   // id → Buyer
  contracts:     {},   // id → Contract
  activity:      [],   // [{id, text, color, ts}]
  notifications: [],   // [{id, type, title, body, action_label, action_data, ts}]
  smsStats:      { sent: 0, recv: 0, fail: 0, deliv: 0 },
  phoneIndex:    {},   // normalized-phone → {type, id}
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      STATE = { ...STATE, ...saved };
      const s = Object.keys(STATE.sellers).length;
      const b = Object.keys(STATE.buyers).length;
      console.log(`[State] Loaded: ${s} sellers, ${b} buyers`);
    }
  } catch (e) {
    console.error('[State] Load error:', e.message);
  }
}

let _saveDebounce = null;
function saveState() {
  clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2)); }
    catch (e) { console.error('[State] Save error:', e.message); }
  }, 800);
}

/* ─────────────────────────────────────────────
   PURE HELPERS
───────────────────────────────────────────── */
const uid   = () => Math.random().toString(36).slice(2, 11);
const nowTs = () => Date.now();
const nowTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtMoney = n => '$' + Number(n).toLocaleString();

function normalizePhone(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return raw.trim();
}

function fmtPhone(raw) {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  if (d.length === 11) return `+${d[0]} (${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  return raw;
}

function addActivity(text, color = 'blue') {
  const item = { id: uid(), text, color, ts: nowTs() };
  STATE.activity.push(item);
  if (STATE.activity.length > 300) STATE.activity = STATE.activity.slice(-300);
  return item;
}

function pushNotif(type, title, body, actionLabel = null, actionData = null) {
  const n = { id: uid(), type, title, body, action_label: actionLabel, action_data: actionData, ts: nowTs() };
  STATE.notifications.push(n);
  return n;
}

/* Build Claude conversation history from stored messages */
function buildHistory(msgs, limit = 10) {
  return (msgs || [])
    .filter(m => m.role === 'ai' || m.role === 'prospect')
    .slice(-limit)
    .map(m => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.text }));
}

/* Append a message to a lead's msg log */
function appendMsg(entity, role, text, smsStatus = 'sent') {
  if (!entity.msgs) entity.msgs = [];
  entity.msgs.push({ role, text, time: nowTime(), ts: nowTs(), sms_status: smsStatus });
  if (entity.msgs.length > 200) entity.msgs = entity.msgs.slice(-200);
}

/* ─────────────────────────────────────────────
   SMS GATEWAY  (Twilio)
───────────────────────────────────────────── */
async function sendSMS(to, body) {
  const client = getTwilio();
  if (!client) {
    console.log(`[SMS DEMO] ➜ ${to}: "${body.slice(0, 60)}..."`);
    STATE.smsStats.sent++;
    return { sid: 'DEMO_' + uid(), demo: true };
  }
  try {
    const msg = await client.messages.create({ body, from: CFG.TWILIO_FROM, to });
    STATE.smsStats.sent++;
    console.log(`[SMS] ✓ ${to}  SID=${msg.sid}`);
    return { sid: msg.sid };
  } catch (e) {
    STATE.smsStats.fail++;
    console.error(`[SMS] ✗ ${to}: ${e.message}`);
    throw e;
  }
}

/* ─────────────────────────────────────────────
   AI ENGINE  (Anthropic Claude)
───────────────────────────────────────────── */
async function callClaude(messages, maxTokens = 320) {
  const client = getAnthropic();
  if (!client) {
    console.log('[Claude DEMO] No API key — returning null');
    return null;
  }
  try {
    const res = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages,
    });
    return res.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('[Claude] Error:', e.message);
    return null;
  }
}

/* ─── SYSTEM PROMPTS ─── */
function sellerQualifyPrompt(seller) {
  return `You are ${CFG.AI_PERSONA}, a professional real estate wholesaler at ${CFG.COMPANY_NAME}. You are texting the property owner${seller.name ? ' ' + seller.name : ''} about possibly purchasing their property${seller.address ? ' at ' + seller.address : ''}.

YOUR ROLE: Qualify motivated sellers and gauge interest in a cash sale.

RULES:
- Harvard-level grammar, warm and professional, never pushy
- Answer FAQs clearly (all-cash, 7–14 day close, no repairs, no realtor fees, no commissions, no inspection contingencies)
- If they ask about process: emphasize speed, simplicity, certainty
- NEVER reveal you are AI; you are ${CFG.AI_PERSONA} from ${CFG.COMPANY_NAME}
- NEVER quote a price until you receive specific instructions to negotiate
- SMS format: keep responses to 3–5 sentences maximum
- If they seem interested, ask about property condition and ideal timeline`;
}

function sellerNegotiatePrompt(seller) {
  return `You are ${CFG.AI_PERSONA} from ${CFG.COMPANY_NAME}, negotiating to purchase ${seller.name || 'a seller'}'s property${seller.address ? ' at ' + seller.address : ''}.

HARD PRICE CEILING — NEVER VIOLATE:
• Your opening offer: ${fmtMoney(seller.priceLowball)}
• Minimum: ${fmtMoney(seller.priceMin)}
• ABSOLUTE MAXIMUM: ${fmtMoney(seller.priceMax)} — DO NOT EXCEED THIS UNDER ANY CIRCUMSTANCES
• Offer history so far: ${(seller.offerHistory || []).map(o => `${o.from === 'ai' ? 'Our offer' : 'Their ask'}: ${fmtMoney(o.amount)}`).join(' → ') || 'None yet'}

STRATEGY:
1. Open at lowball, justify with: market comps, repair costs, as-is risk, speed/certainty of cash close
2. Concede in small steps (5–10% max per round), never more than 2 concessions without reciprocation
3. Highlight: all-cash, no realtor fees, no repairs, close in 7–14 days
4. If counter exceeds your max: politely hold firm, explain business constraints
5. Once at max with no deal: gracefully walk away, leave door open
6. 3–5 sentences max. Professional, never desperate.

Additional notes: ${seller.priceNotes || 'None'}`;
}

function buyerPitchPrompt(buyer, contract) {
  const prop = contract
    ? `${contract.address} (purchased at ${fmtMoney(contract.purchasePrice)})`
    : 'an exclusive off-market property';
  return `You are ${CFG.AI_PERSONA} from ${CFG.COMPANY_NAME}, pitching an assignment contract to investor ${buyer.name || 'a cash buyer'}.

DEAL DETAILS:
• Property: ${prop}
• Assignment fee range: ${fmtMoney(buyer.feeMin)} – ${fmtMoney(buyer.feeMax)}

YOUR ROLE: Present this as a compelling investment. Answer all property/process questions. Pitch the deal's merits (below market value, ARV upside, fast close, zero contingencies). Use professional investor language. SMS: 3–5 sentences max. Never say you are an AI.`;
}

function buyerNegotiatePrompt(buyer, contract) {
  const prop = contract ? contract.address : 'the property';
  return `You are ${CFG.AI_PERSONA} from ${CFG.COMPANY_NAME}, negotiating an assignment fee with ${buyer.name || 'a buyer'} for ${prop}.

FEE CONSTRAINTS — NON-NEGOTIABLE:
• Minimum fee (NEVER go below this): ${fmtMoney(buyer.feeMin)}
• Maximum ask: ${fmtMoney(buyer.feeMax)}
• Current offer history: ${(buyer.offerHistory || []).map(o => `${o.from === 'ai' ? 'Our ask' : 'Buyer offered'}: ${fmtMoney(o.amount)}`).join(' → ') || 'None yet'}

STRATEGY: Justify fee with deal's profit potential, ARV upside, exclusive nature, fast close. Concede slowly toward min. Never go below ${fmtMoney(buyer.feeMin)}. Keep SMS to 3–5 sentences.`;
}

/* ─── INTENT DETECTION ─── */
const NOT_INTERESTED_KEYWORDS = ['not interested','no thanks','stop','unsubscribe','dont contact','do not contact','remove me','opt out','wrong number','not selling','leave me alone','no deal','not for sale','i said no','please remove','take me off'];
const INTERESTED_KEYWORDS = ['interested','tell me more','how much','make me an offer','what\'s your offer','what is your offer','maybe','possibly','open to','sure','go ahead','sounds good','how does it work','what do you do','let\'s talk','let me hear','i\'m listening','yes'];
const FAQ_KEYWORDS = ['how long','how does','what is','do i need','commission','fees','realtor','agent','repairs','condition','as is','closing','timeline','process','work','what happens','how much does','closing costs'];

async function detectSellerIntent(message) {
  const lower = (message || '').toLowerCase();
  if (NOT_INTERESTED_KEYWORDS.some(k => lower.includes(k))) return 'not_interested';
  if (INTERESTED_KEYWORDS.some(k => lower.includes(k))) return 'interested';
  if (FAQ_KEYWORDS.some(k => lower.includes(k))) return 'faq';

  // Use Claude for ambiguous messages
  const result = await callClaude([{
    role: 'user',
    content: `You are classifying a real estate SMS response. Respond ONLY with one word from this list: [interested, not_interested, faq, unclear]

Message: "${message}"

Classification:`
  }], 5);
  return (result || 'unclear').trim().toLowerCase().replace(/[^a-z_]/g, '');
}

async function detectNegotiationIntent(message, currentOffer) {
  const lower = (message || '').toLowerCase();

  // Extract dollar amount
  const priceMatch = message.match(/\$?([\d,]+)\s*k?\b/i);
  let extracted = null;
  if (priceMatch) {
    let n = parseInt(priceMatch[1].replace(/,/g, ''));
    if (/\bk\b/i.test(message.slice(priceMatch.index))) n *= 1000;
    if (n > 1000) extracted = n;
  }

  const AGREED = ['deal','i accept','accepted','i agree','let\'s do it','sounds good','works for me','you got it','we have a deal','i\'ll take it','ok deal','okay deal','agreed','yes deal','done deal'];
  const WALK   = ['forget it','never','not happening','ridiculous','insulting','no way','final answer','take it or leave','that\'s all i\'m'];

  if (AGREED.some(k => lower.includes(k))) return { intent: 'agreed', price: extracted || currentOffer };
  if (WALK.some(k => lower.includes(k)) && !extracted) return { intent: 'firm_no', price: null };
  if (extracted) return { intent: 'counter', price: extracted };
  return { intent: 'unclear', price: null };
}

async function detectBuyerNegotiationIntent(message, currentOffer) {
  const lower = (message || '').toLowerCase();
  const priceMatch = message.match(/\$?([\d,]+)\s*k?\b/i);
  let extracted = null;
  if (priceMatch) {
    let n = parseInt(priceMatch[1].replace(/,/g, ''));
    if (/\bk\b/i.test(message.slice(priceMatch.index))) n *= 1000;
    if (n > 500) extracted = n;
  }
  const AGREED  = ['deal','i accept','let\'s do it','sounds good','works for me','you got it','agreed','i\'ll take it','ok done','yes let\'s go'];
  const DECLINE = ['too high','can\'t do','not worth','no deal','forget it','pass','not interested','way too much'];

  if (AGREED.some(k => lower.includes(k))) return { intent: 'agreed', fee: extracted || currentOffer };
  if (DECLINE.some(k => lower.includes(k)) && !extracted) return { intent: 'declined', fee: null };
  if (extracted) return { intent: 'counter', fee: extracted };
  return { intent: 'unclear', fee: null };
}

/* ─────────────────────────────────────────────
   SELLER FLOW
───────────────────────────────────────────── */
async function launchSellerOutreach(seller) {
  const fname = (seller.name || '').split(' ')[0] || 'there';
  const opening =
    `Hi ${fname}, this is ${CFG.AI_PERSONA} with ${CFG.COMPANY_NAME}. ` +
    `We buy homes directly from homeowners — all cash, no agents, no fees, no repairs needed. ` +
    `I'm reaching out about your property${seller.address ? ' at ' + seller.address : ''}. ` +
    `Are you at all open to a cash offer? Happy to make it quick and hassle-free.`;
  try {
    const { sid, demo } = await sendSMS(seller.phone, opening);
    appendMsg(seller, 'ai', opening, demo ? 'demo' : 'sent');
    seller.followups = 1;
    seller.status = 'new';
    addActivity(`Cold message sent → ${seller.name || seller.phone}`, 'blue');
    saveState();
    scheduleSellerFollowup(seller.id);
  } catch (e) {
    appendMsg(seller, 'ai', `[Failed: ${e.message}]`, 'failed');
    seller.status = 'error';
    saveState();
  }
}

async function handleSellerSMS(seller, inbound) {
  appendMsg(seller, 'prospect', inbound);
  cancelFollowup(seller.id);

  if (seller.aiPaused) {
    saveState();
    return; // owner has taken over manually
  }

  if (seller.negotiationActive) {
    await handleSellerNegotiationResponse(seller, inbound);
    return;
  }

  const intent = await detectSellerIntent(inbound);
  console.log(`[Seller] ${seller.name || seller.phone} → intent: ${intent}`);

  if (intent === 'not_interested') {
    const fname = (seller.name || '').split(' ')[0] || 'there';
    const aiText = await callClaude([
      { role: 'system', content: sellerQualifyPrompt(seller) },
      ...buildHistory(seller.msgs),
      { role: 'user', content: `The prospect said: "${inbound}" — they do NOT want to sell right now. Send a brief 2-sentence warm goodbye. Thank them, leave door open for future, wish them well.` }
    ]);
    const msg = aiText ||
      `Absolutely no worries, ${fname}! If your situation ever changes and selling becomes an option, please don't hesitate to reach back out — we'd love to help. Wishing you all the best!`;
    await sendSMS(seller.phone, msg);
    appendMsg(seller, 'ai', msg, 'sent');
    seller.status = 'lost';
    seller.removedAt = nowTs();
    addActivity(`${seller.name || seller.phone} not interested — removed`, 'red');
    pushNotif('info', `Lead removed: ${seller.name || seller.phone}`, `Prospect indicated they are not selling. AI sent a polite goodbye.`);
    saveState();

  } else if (intent === 'interested' || intent === 'faq' || intent === 'unclear') {
    const aiText = await callClaude([
      { role: 'system', content: sellerQualifyPrompt(seller) },
      ...buildHistory(seller.msgs),
      { role: 'user', content: inbound }
    ]);
    const msg = aiText ||
      `That's great to hear! We work with homeowners in all kinds of situations — inherited homes, needing to relocate, or just ready to simplify. What does your situation look like with the property, and what's your timeline?`;
    await sendSMS(seller.phone, msg);
    appendMsg(seller, 'ai', msg, 'sent');

    if (seller.status !== 'warm' && seller.status !== 'negotiating' && seller.status !== 'done') {
      seller.status = 'warm';
      seller.score = Math.min(100, (seller.score || 50) + 20);
      addActivity(`🔥 ${seller.name || seller.phone} is interested!`, 'amber');
      pushNotif(
        'warning',
        `Interested seller: ${seller.name || seller.phone}`,
        `${seller.name || seller.phone} appears open to selling${seller.address ? ' (' + seller.address + ')' : ''}. Set your price range so the AI can begin negotiating.`,
        'Set Price Range',
        { action: 'set_price', sellerId: seller.id }
      );
    }
    saveState();
    scheduleSellerFollowup(seller.id);
  }
}

async function activateNegotiation(seller) {
  seller.negotiationActive = true;
  seller.status = 'negotiating';
  seller.offerHistory = [];
  seller.lastAiOffer = seller.priceLowball;
  seller.offerHistory.push({ from: 'ai', amount: seller.priceLowball, ts: nowTs() });

  const aiText = await callClaude([
    { role: 'system', content: sellerNegotiatePrompt(seller) },
    { role: 'user', content: `Open the negotiation. Make your opening offer of ${fmtMoney(seller.priceLowball)}. Justify it with: all-cash speed, as-is purchase, repair estimates, market analysis. Warm but firm, 4–5 sentences.` }
  ]);
  const msg = aiText ||
    `Based on our thorough analysis of the market and the property's current condition, we'd like to open with an all-cash offer of ${fmtMoney(seller.priceLowball)}. ` +
    `This reflects repair costs and market data, but gives you certainty — no contingencies, no realtor fees, and we can close in as little as 7 days. ` +
    `That's real money in your pocket, fast, with zero headaches. What are your thoughts?`;
  await sendSMS(seller.phone, msg);
  appendMsg(seller, 'ai', msg, 'sent');
  addActivity(`AI negotiation opened with ${seller.name} at ${fmtMoney(seller.priceLowball)}`, 'accent');
  saveState();
}

async function handleSellerNegotiationResponse(seller, inbound) {
  if (!seller.offerHistory) seller.offerHistory = [];
  const { intent, price } = await detectNegotiationIntent(inbound, seller.lastAiOffer);
  console.log(`[Negotiation:Seller] ${seller.name} → intent: ${intent}, price: ${price}`);

  if (intent === 'agreed') {
    const agreedAt = price || seller.lastAiOffer;
    if (agreedAt > seller.priceMax) {
      // They agreed but at a number we can't honor — must clarify or walk away
      await handleSellerWalkaway(seller, `Prospect's agreed price ${fmtMoney(agreedAt)} exceeds our ceiling of ${fmtMoney(seller.priceMax)}`);
      return;
    }
    seller.agreedPrice = agreedAt;
    seller.negotiationActive = false;
    seller.status = 'done';
    seller.score = 100;
    seller.offerHistory.push({ from: 'prospect', amount: agreedAt, ts: nowTs() });

    const aiText = await callClaude([
      { role: 'system', content: sellerNegotiatePrompt(seller) },
      { role: 'user', content: `The seller just agreed to ${fmtMoney(agreedAt)}! Express genuine enthusiasm, confirm the verbal agreement, and let them know a purchase agreement will be sent for their review very soon. Warm, excited, professional. 3 sentences.` }
    ]);
    const msg = aiText ||
      `We have a deal — ${fmtMoney(agreedAt)} it is, and I couldn't be more excited to make this happen for you! ` +
      `I'll have a purchase agreement sent over for your review very shortly. ` +
      `Thank you for trusting us — this is going to be a smooth, stress-free close!`;
    await sendSMS(seller.phone, msg);
    appendMsg(seller, 'ai', msg, 'sent');

    // Create contract entry
    const cid = uid();
    STATE.contracts[cid] = {
      id: cid,
      sellerId: seller.id,
      address: seller.address || '',
      sellerName: seller.name,
      purchasePrice: agreedAt,
      feeMin: Math.round(agreedAt * 0.07),
      feeMax: Math.round(agreedAt * 0.14),
      status: 'pending',
      assignedBuyerId: null,
      ts: nowTs(),
    };
    addActivity(`🎉 DEAL! ${seller.name} agreed to ${fmtMoney(agreedAt)} — ${seller.address || 'property'}`, 'green');
    pushNotif(
      'success',
      `Deal agreed — ${seller.address || seller.name}`,
      `${seller.name} verbally agreed to ${fmtMoney(agreedAt)}. Upload your purchase agreement to send to them.`,
      'Send Contract',
      { action: 'send_contract', sellerId: seller.id }
    );
    saveState();

  } else if (intent === 'counter') {
    seller.offerHistory.push({ from: 'prospect', amount: price, ts: nowTs() });

    if (price > seller.priceMax) {
      // Their ask is above our ceiling — make one final move to max, then hold
      const prevOffer = seller.lastAiOffer || seller.priceLowball;
      const finalOffer = seller.priceMax;
      const alreadyAtMax = prevOffer >= seller.priceMax;

      if (alreadyAtMax) {
        await handleSellerWalkaway(seller, `Seller countered at ${fmtMoney(price)}, which is above our maximum of ${fmtMoney(seller.priceMax)}, and we are already at our ceiling`);
        return;
      }

      const aiText = await callClaude([
        { role: 'system', content: sellerNegotiatePrompt(seller) },
        { role: 'user', content: `Seller countered at ${fmtMoney(price)} but our absolute maximum is ${fmtMoney(seller.priceMax)}. Move up to ${fmtMoney(finalOffer)} as our final position and explain why we cannot go higher. Firm but respectful. 4 sentences.` }
      ]);
      const msg = aiText ||
        `I truly appreciate your position and want to make this work. ` +
        `The absolute most we can do — given our repair analysis and return requirements — is ${fmtMoney(finalOffer)}, and that's our final ceiling. ` +
        `This is still all-cash, with no fees, no contingencies, and a 7-day close. ` +
        `Is there any way we can make ${fmtMoney(finalOffer)} work for you?`;
      await sendSMS(seller.phone, msg);
      appendMsg(seller, 'ai', msg, 'sent');
      seller.lastAiOffer = finalOffer;
      seller.offerHistory.push({ from: 'ai', amount: finalOffer, ts: nowTs() });

    } else {
      // Counter is within or below our range — move up strategically
      const gap = price - (seller.lastAiOffer || seller.priceLowball);
      const nextOffer = Math.min(seller.priceMax, Math.round((seller.lastAiOffer || seller.priceLowball) + gap * 0.55));

      const aiText = await callClaude([
        { role: 'system', content: sellerNegotiatePrompt(seller) },
        { role: 'user', content: `Seller countered at ${fmtMoney(price)}. Our previous offer was ${fmtMoney(seller.lastAiOffer || seller.priceLowball)}. Move to ${fmtMoney(nextOffer)} — meet them part-way, justify the value (cash, speed, no repairs, no fees). 4 sentences.` }
      ]);
      const msg = aiText ||
        `I hear you, and I want to bridge the gap here. ` +
        `I can move to ${fmtMoney(nextOffer)} — that's a meaningful move on my end, and it comes with all the same advantages: all cash, no realtor commissions, no repair demands, close in 7–14 days. ` +
        `That's a clean, certain transaction with money in your pocket fast. Can we land at ${fmtMoney(nextOffer)}?`;
      await sendSMS(seller.phone, msg);
      appendMsg(seller, 'ai', msg, 'sent');
      seller.lastAiOffer = nextOffer;
      seller.offerHistory.push({ from: 'ai', amount: nextOffer, ts: nowTs() });
    }
    saveState();

  } else if (intent === 'firm_no') {
    await handleSellerWalkaway(seller, 'Seller is firm on a price outside our range');

  } else {
    // Unclear — keep conversation alive, re-anchor to offer
    const aiText = await callClaude([
      { role: 'system', content: sellerNegotiatePrompt(seller) },
      ...buildHistory(seller.msgs, 6),
      { role: 'user', content: `Prospect said: "${inbound}". Re-engage professionally, gently re-anchor to your current offer of ${fmtMoney(seller.lastAiOffer || seller.priceLowball)}. Keep it brief.` }
    ]);
    const msg = aiText ||
      `I want to make sure we're on the same page — our current offer is ${fmtMoney(seller.lastAiOffer || seller.priceLowball)}, all cash, no strings attached. ` +
      `Is there anything I can clarify about the process or the offer that would help you decide?`;
    await sendSMS(seller.phone, msg);
    appendMsg(seller, 'ai', msg, 'sent');
    saveState();
  }
}

async function handleSellerWalkaway(seller, reason) {
  seller.negotiationActive = false;
  seller.status = 'cold';
  const fname = (seller.name || '').split(' ')[0] || 'there';

  const aiText = await callClaude([
    { role: 'system', content: sellerNegotiatePrompt(seller) },
    { role: 'user', content: `${reason}. Send a gracious, professional message declining at this time. Express genuine appreciation for their time, acknowledge their position, and leave the door WIDE open for the future. Warm, 3 sentences, no bitterness.` }
  ]);
  const msg = aiText ||
    `I really appreciate your time and the opportunity to discuss this, ${fname} — I only wish we could've landed at a number that worked for both of us. ` +
    `If your situation ever changes or the market shifts, please don't hesitate to reach back out — our door is always open. ` +
    `Wishing you nothing but the best going forward!`;
  await sendSMS(seller.phone, msg);
  appendMsg(seller, 'ai', msg, 'sent');
  addActivity(`Negotiation ended with ${seller.name} — out of price range`, 'amber');
  pushNotif(
    'info',
    `Negotiation ended: ${seller.name}`,
    `Prospect's price exceeded your max of ${fmtMoney(seller.priceMax)}. AI respectfully declined and left the door open.`
  );
  saveState();
}

/* ─────────────────────────────────────────────
   BUYER FLOW
───────────────────────────────────────────── */
async function launchBuyerOutreach(buyer) {
  const fname = (buyer.name || '').split(' ')[0] || 'there';
  const contract = buyer.contractId ? STATE.contracts[buyer.contractId] : null;
  const propDetail = contract
    ? `a ${contract.address} property we have under contract at ${fmtMoney(contract.purchasePrice)}`
    : 'an exclusive off-market investment opportunity';

  const opening =
    `Hello ${fname}, this is ${CFG.AI_PERSONA} representing ${CFG.COMPANY_NAME}. ` +
    `I'm reaching out about ${propDetail} — assignment fee ${fmtMoney(buyer.feeMin)}–${fmtMoney(buyer.feeMax)}, all-cash, fast close. ` +
    `Would you like the full property details?`;
  try {
    const { demo } = await sendSMS(buyer.phone, opening);
    appendMsg(buyer, 'ai', opening, demo ? 'demo' : 'sent');
    buyer.followups = 1;
    buyer.status = 'new';
    addActivity(`Buyer outreach sent → ${buyer.name || buyer.phone}`, 'blue');
    saveState();
    scheduleBuyerFollowup(buyer.id);
  } catch (e) {
    appendMsg(buyer, 'ai', `[Failed: ${e.message}]`, 'failed');
    buyer.status = 'error';
    saveState();
  }
}

async function handleBuyerSMS(buyer, inbound) {
  appendMsg(buyer, 'prospect', inbound);
  cancelFollowup(buyer.id);

  if (buyer.aiPaused) { saveState(); return; }

  const contract = buyer.contractId ? STATE.contracts[buyer.contractId] : null;

  if (buyer.negotiationActive) {
    await handleBuyerNegotiationResponse(buyer, inbound, contract);
    return;
  }

  const intent = await detectSellerIntent(inbound); // reuses same keyword logic
  console.log(`[Buyer] ${buyer.name || buyer.phone} → intent: ${intent}`);

  if (intent === 'not_interested') {
    const fname = (buyer.name || '').split(' ')[0] || 'there';
    const aiText = await callClaude([
      { role: 'system', content: buyerPitchPrompt(buyer, contract) },
      { role: 'user', content: `Buyer replied "${inbound}" — not interested. Professional 2-sentence thank-you, leave door open for future deals.` }
    ]);
    const msg = aiText ||
      `Thank you so much for your time, ${fname} — I completely understand! If you ever come across a deal or opportunity in the future, please keep us in mind. Best of luck with your portfolio!`;
    await sendSMS(buyer.phone, msg);
    appendMsg(buyer, 'ai', msg, 'sent');
    buyer.status = 'cold';
    buyer.interest = 'Low';
    addActivity(`Buyer ${buyer.name} not interested`, 'red');
    saveState();

  } else {
    // Interested or FAQ — enter negotiation
    buyer.status = 'warm';
    buyer.interest = 'High';
    buyer.score = Math.min(100, (buyer.score || 50) + 25);
    buyer.negotiationActive = true;
    buyer.offerHistory = [{ from: 'ai', amount: buyer.feeMax, ts: nowTs() }];
    buyer.lastAiOffer = buyer.feeMax;

    const aiText = await callClaude([
      { role: 'system', content: buyerPitchPrompt(buyer, contract) },
      ...buildHistory(buyer.msgs, 4),
      { role: 'user', content: inbound }
    ]);
    const msg = aiText ||
      `Excellent — happy to share the details! This is a strong cash deal with solid ARV upside in a desirable area. ` +
      `The assignment fee is ${fmtMoney(buyer.feeMax)}, which we believe reflects the deal's value. ` +
      `Would that work for you, or would you like to discuss further?`;
    await sendSMS(buyer.phone, msg);
    appendMsg(buyer, 'ai', msg, 'sent');
    addActivity(`Buyer ${buyer.name} is interested — AI negotiating fee`, 'green');
    pushNotif('warning', `Hot buyer: ${buyer.name}`, `${buyer.name} engaged. AI is negotiating the assignment fee.`);
    saveState();
    scheduleBuyerFollowup(buyer.id);
  }
}

async function handleBuyerNegotiationResponse(buyer, inbound, contract) {
  if (!buyer.offerHistory) buyer.offerHistory = [];
  const { intent, fee } = await detectBuyerNegotiationIntent(inbound, buyer.lastAiOffer);
  console.log(`[Negotiation:Buyer] ${buyer.name} → intent: ${intent}, fee: ${fee}`);

  if (intent === 'agreed') {
    const agreedFee = fee || buyer.lastAiOffer || buyer.feeMin;
    if (agreedFee < buyer.feeMin) {
      // Below our floor — counter at min
      const aiText = await callClaude([
        { role: 'system', content: buyerNegotiatePrompt(buyer, contract) },
        { role: 'user', content: `Buyer agreed but at ${fmtMoney(agreedFee)} which is below our minimum of ${fmtMoney(buyer.feeMin)}. Counter at ${fmtMoney(buyer.feeMin)} as the absolute floor. Keep deal alive. 3 sentences.` }
      ]);
      const msg = aiText ||
        `I appreciate your enthusiasm and want to get this done! ` +
        `Our absolute floor on this assignment is ${fmtMoney(buyer.feeMin)} — that's the very best we can do given the deal value. ` +
        `Can you meet us at ${fmtMoney(buyer.feeMin)} to lock this in?`;
      await sendSMS(buyer.phone, msg);
      appendMsg(buyer, 'ai', msg, 'sent');
      buyer.lastAiOffer = buyer.feeMin;
      buyer.offerHistory.push({ from: 'ai', amount: buyer.feeMin, ts: nowTs() });
      saveState();
      return;
    }

    buyer.agreedFee = agreedFee;
    buyer.negotiationActive = false;
    buyer.status = 'done';
    buyer.interest = 'High';
    buyer.offerHistory.push({ from: 'prospect', amount: agreedFee, ts: nowTs() });

    if (contract) { contract.status = 'assigned'; contract.assignedBuyerId = buyer.id; }

    const aiText = await callClaude([
      { role: 'system', content: buyerNegotiatePrompt(buyer, contract) },
      { role: 'user', content: `Buyer agreed to ${fmtMoney(agreedFee)}! Confirm the deal with excitement. Tell them the assignment contract will be sent shortly and the title company will be in touch. Professional enthusiasm. 3 sentences.` }
    ]);
    const msg = aiText ||
      `We have a deal at ${fmtMoney(agreedFee)} — fantastic! ` +
      `I'll get the assignment contract sent over to you today for your review. ` +
      `Our title company will reach out shortly to coordinate the closing — this is going to be a great transaction!`;
    await sendSMS(buyer.phone, msg);
    appendMsg(buyer, 'ai', msg, 'sent');
    addActivity(`🎉 Buyer ${buyer.name} agreed — ${fmtMoney(agreedFee)} assignment fee!`, 'green');
    pushNotif(
      'success',
      `Buyer deal agreed: ${fmtMoney(agreedFee)} fee`,
      `${buyer.name} agreed to the ${fmtMoney(agreedFee)} assignment fee. Upload the assignment contract and call your title company.`,
      'Send Assignment Contract',
      { action: 'send_assignment', buyerId: buyer.id }
    );
    saveState();

  } else if (intent === 'counter') {
    buyer.offerHistory.push({ from: 'prospect', amount: fee, ts: nowTs() });

    if (fee < buyer.feeMin) {
      // Below our floor
      const aiText = await callClaude([
        { role: 'system', content: buyerNegotiatePrompt(buyer, contract) },
        { role: 'user', content: `Buyer offered ${fmtMoney(fee)}, below our floor of ${fmtMoney(buyer.feeMin)}. Politely decline and counter at ${fmtMoney(buyer.feeMin)} as the absolute minimum, justify the deal's value. 3 sentences.` }
      ]);
      const msg = aiText ||
        `I really want to make this work, and I've pushed as hard as I can internally. ` +
        `The very floor on this assignment is ${fmtMoney(buyer.feeMin)} — that's the minimum that covers our costs and effort on this deal. ` +
        `The profit upside for you at this price point is genuinely strong. Can you meet us at ${fmtMoney(buyer.feeMin)}?`;
      await sendSMS(buyer.phone, msg);
      appendMsg(buyer, 'ai', msg, 'sent');
      buyer.lastAiOffer = buyer.feeMin;
      buyer.offerHistory.push({ from: 'ai', amount: buyer.feeMin, ts: nowTs() });

    } else {
      // Within range — split the difference slightly in our favor
      const counter = Math.min(buyer.feeMax, Math.round((fee + (buyer.lastAiOffer || buyer.feeMax)) / 2));
      const aiText = await callClaude([
        { role: 'system', content: buyerNegotiatePrompt(buyer, contract) },
        { role: 'user', content: `Buyer offered ${fmtMoney(fee)}. Our last ask was ${fmtMoney(buyer.lastAiOffer || buyer.feeMax)}. Counter at ${fmtMoney(counter)}, acknowledge their offer, justify the split. 3 sentences.` }
      ]);
      const msg = aiText ||
        `I appreciate that offer and want to land somewhere both of us feel good about. ` +
        `How about we split the difference at ${fmtMoney(counter)}? ` +
        `At that price you're still walking into a deal with exceptional upside — let's make it official!`;
      await sendSMS(buyer.phone, msg);
      appendMsg(buyer, 'ai', msg, 'sent');
      buyer.lastAiOffer = counter;
      buyer.offerHistory.push({ from: 'ai', amount: counter, ts: nowTs() });
    }
    saveState();

  } else if (intent === 'declined') {
    const fname = (buyer.name || '').split(' ')[0] || 'there';
    const aiText = await callClaude([
      { role: 'system', content: buyerNegotiatePrompt(buyer, contract) },
      { role: 'user', content: `Buyer is declining. Professional 2-sentence goodbye. Leave door open for future deals.` }
    ]);
    const msg = aiText ||
      `Completely understand, ${fname} — not every deal is the right fit, and I respect that! ` +
      `If you ever want first access to future off-market assignments, just reach out — we'd love to work with you down the road.`;
    await sendSMS(buyer.phone, msg);
    appendMsg(buyer, 'ai', msg, 'sent');
    buyer.status = 'cold';
    buyer.negotiationActive = false;
    addActivity(`Buyer ${buyer.name} declined — negotiation ended`, 'amber');
    saveState();

  } else {
    // Unclear — re-engage
    const aiText = await callClaude([
      { role: 'system', content: buyerNegotiatePrompt(buyer, contract) },
      ...buildHistory(buyer.msgs, 4),
      { role: 'user', content: `Buyer said: "${inbound}". Re-engage, re-state your fee of ${fmtMoney(buyer.lastAiOffer || buyer.feeMax)}, and invite a yes or counter. Brief.` }
    ]);
    const msg = aiText ||
      `Happy to clarify! Our assignment fee for this deal is ${fmtMoney(buyer.lastAiOffer || buyer.feeMax)}. ` +
      `Does that work for you, or did you have a number in mind?`;
    await sendSMS(buyer.phone, msg);
    appendMsg(buyer, 'ai', msg, 'sent');
    saveState();
  }
}

/* ─────────────────────────────────────────────
   FOLLOW-UP SCHEDULER
───────────────────────────────────────────── */
const timers = {};

function cancelFollowup(id) {
  if (timers[id]) { clearTimeout(timers[id]); delete timers[id]; }
}

const SELLER_FOLLOWUPS = [
  (fname, addr) => `Hi ${fname}, just following up! We're still interested in a cash offer for your property${addr ? ' at ' + addr : ''}. Any thoughts?`,
  (fname)       => `${fname}, checking back in — our cash offer is still available. All-cash, no fees, fast close. Worth a quick conversation?`,
  (fname)       => `Hey ${fname}, third follow-up here — I don't want to overwhelm you. If selling is even a distant option, we'd love to be your first call. No pressure!`,
  (fname)       => `${fname}, one more check-in on the cash offer for your property. If you have any questions about our process, I'm happy to answer them!`,
  (fname, addr) => `${fname}, this will be my final message so I don't clutter your inbox. If selling ever makes sense — now or down the road — please reach out. Wishing you all the best!`,
];

const BUYER_FOLLOWUPS = [
  (fname, feeMin, feeMax) => `Hi ${fname}, following up on the off-market investment opportunity! Assignment fee ${fmtMoney(feeMin)}–${fmtMoney(feeMax)}, still available. Interested in details?`,
  (fname)                  => `${fname}, checking back in — this is a fast-close cash deal with strong upside. Happy to answer any questions!`,
  (fname)                  => `Hey ${fname}, third follow-up — if timing or fee is the concern, I'm very open to a quick conversation!`,
  (fname)                  => `${fname}, one last reach-out — would love to send you the full property package if you're at all open to it.`,
  (fname)                  => `${fname}, final message from me! If you ever want first access to off-market deals in the future, please keep us in mind. Best wishes!`,
];

function scheduleSellerFollowup(sellerId, delayMs) {
  const delay = delayMs ?? CFG.FOLLOWUP_DELAY_MS;
  cancelFollowup(sellerId);
  timers[sellerId] = setTimeout(async () => {
    const seller = STATE.sellers[sellerId];
    if (!seller) return;
    if (['done', 'lost', 'cold', 'error'].includes(seller.status)) return;
    if (seller.followups >= CFG.MAX_FOLLOWUPS) {
      seller.status = 'cold';
      addActivity(`${seller.name} max follow-ups reached — marked cold`, 'text3');
      saveState();
      return;
    }
    seller.followups++;
    const fname = (seller.name || '').split(' ')[0] || 'there';
    const idx = Math.min(seller.followups - 2, SELLER_FOLLOWUPS.length - 1);
    const msg = SELLER_FOLLOWUPS[idx](fname, seller.address);
    try {
      await sendSMS(seller.phone, msg);
      appendMsg(seller, 'ai', msg, 'sent');
      addActivity(`Follow-up #${seller.followups} → ${seller.name}`, 'blue');
      saveState();
      if (seller.followups < CFG.MAX_FOLLOWUPS) scheduleSellerFollowup(sellerId);
    } catch (e) {
      console.error(`[Follow-up:Seller] ${seller.name}: ${e.message}`);
    }
  }, delay);
}

function scheduleBuyerFollowup(buyerId, delayMs) {
  const delay = delayMs ?? CFG.FOLLOWUP_DELAY_MS;
  cancelFollowup(buyerId);
  timers[buyerId] = setTimeout(async () => {
    const buyer = STATE.buyers[buyerId];
    if (!buyer) return;
    if (['done', 'cold', 'error'].includes(buyer.status)) return;
    if (buyer.followups >= CFG.MAX_FOLLOWUPS) {
      buyer.status = 'cold';
      saveState();
      return;
    }
    buyer.followups++;
    const fname = (buyer.name || '').split(' ')[0] || 'there';
    const idx = Math.min(buyer.followups - 2, BUYER_FOLLOWUPS.length - 1);
    const msg = BUYER_FOLLOWUPS[idx](fname, buyer.feeMin, buyer.feeMax);
    try {
      await sendSMS(buyer.phone, msg);
      appendMsg(buyer, 'ai', msg, 'sent');
      addActivity(`Buyer follow-up #${buyer.followups} → ${buyer.name}`, 'blue');
      saveState();
      if (buyer.followups < CFG.MAX_FOLLOWUPS) scheduleBuyerFollowup(buyerId);
    } catch (e) {
      console.error(`[Follow-up:Buyer] ${buyer.name}: ${e.message}`);
    }
  }, delay);
}

/* ─────────────────────────────────────────────
   API ROUTES
───────────────────────────────────────────── */

/* Health check */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    mode: isProduction() ? 'production' : 'demo',
    version: '2.0.0',
    sellers: Object.keys(STATE.sellers).length,
    buyers:  Object.keys(STATE.buyers).length,
    ...STATE.smsStats,
  });
});

/* Full state sync for frontend polling */
app.get('/api/state', (req, res) => {
  res.json({
    sellers:       Object.values(STATE.sellers),
    buyers:        Object.values(STATE.buyers),
    contracts:     Object.values(STATE.contracts),
    activity:      STATE.activity.slice(-80),
    notifications: STATE.notifications.slice(-50),
    smsSent:  STATE.smsStats.sent,
    smsRecv:  STATE.smsStats.recv,
    smsFail:  STATE.smsStats.fail,
    smsDeliv: STATE.smsStats.deliv,
    mode: isProduction() ? 'production' : 'demo',
  });
});

/* Get settings (non-secret) */
app.get('/api/settings', (req, res) => {
  res.json({
    ai_persona:          CFG.AI_PERSONA,
    company_name:        CFG.COMPANY_NAME,
    msg_tone:            CFG.MSG_TONE,
    max_followups:       CFG.MAX_FOLLOWUPS,
    followup_delay_hours: CFG.FOLLOWUP_DELAY_MS / 3_600_000,
    twilio_from:         CFG.TWILIO_FROM || '',
    has_twilio:          !!(CFG.TWILIO_SID && CFG.TWILIO_TOKEN),
    has_anthropic:       !!CFG.ANTHROPIC_KEY,
    mode:                isProduction() ? 'production' : 'demo',
  });
});

/* Save settings (including Twilio credentials sent from the UI) */
app.post('/api/settings', (req, res) => {
  const {
    ai_persona, company_name, msg_tone, max_followups, followup_delay_hours,
    twilio_sid, twilio_token, twilio_from, anthropic_key,
    /* legacy field names the frontend may send */
    accountSid, authToken, fromNumber, anthropicKey,
  } = req.body;

  if (ai_persona)          CFG.AI_PERSONA    = ai_persona;
  if (company_name)        CFG.COMPANY_NAME  = company_name;
  if (msg_tone)            CFG.MSG_TONE      = msg_tone;
  if (max_followups)       CFG.MAX_FOLLOWUPS = parseInt(max_followups);
  if (followup_delay_hours) CFG.FOLLOWUP_DELAY_MS = parseInt(followup_delay_hours) * 3_600_000;

  // Accept both naming conventions
  if (twilio_sid   || accountSid)  CFG.TWILIO_SID   = twilio_sid   || accountSid;
  if (twilio_token || authToken)   CFG.TWILIO_TOKEN  = twilio_token || authToken;
  if (twilio_from  || fromNumber)  CFG.TWILIO_FROM   = twilio_from  || fromNumber;
  if (anthropic_key || anthropicKey) CFG.ANTHROPIC_KEY = anthropic_key || anthropicKey;

  res.json({ ok: true, mode: isProduction() ? 'production' : 'demo' });
});

/* Test Twilio (send real SMS) */
app.post('/api/settings/test-twilio', async (req, res) => {
  try {
    const { testPhone } = req.body;
    if (!testPhone) return res.status(400).json({ error: 'testPhone required' });
    const phone = normalizePhone(testPhone);
    const result = await sendSMS(phone,
      `✅ DealFlow AI gateway test — Twilio is connected and working perfectly! Time: ${new Date().toLocaleTimeString()}`
    );
    saveState();
    res.json({ ok: true, sid: result.sid, demo: result.demo || false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Launch seller campaign */
app.post('/api/campaigns/seller', async (req, res) => {
  try {
    const { leads = [], config = {} } = req.body;
    if (!leads.length) return res.status(400).json({ error: 'No leads provided' });

    if (config.persona)      CFG.AI_PERSONA    = config.persona;
    if (config.company)      CFG.COMPANY_NAME  = config.company;
    if (config.maxFollowups) CFG.MAX_FOLLOWUPS = parseInt(config.maxFollowups);

    let added = 0;
    let delay = 0;
    for (const lead of leads) {
      const phone = normalizePhone(lead.phone || lead);
      if (!phone || STATE.phoneIndex[phone]) continue; // skip dupes

      const id = uid();
      const seller = {
        id, phone,
        name:    lead.name || fmtPhone(phone),
        address: lead.address || '',
        status:  'new',
        score:   50,
        followups: 0,
        msgs: [],
        offerHistory: [],
        aiPaused: false,
        negotiationActive: false,
        ts: nowTs(),
      };
      STATE.sellers[id] = seller;
      STATE.phoneIndex[phone] = { type: 'seller', id };
      added++;

      // Stagger by 2.5 seconds to respect Twilio rate limits
      const capId = id;
      setTimeout(() => {
        const s = STATE.sellers[capId];
        if (s) launchSellerOutreach(s).catch(console.error);
      }, delay);
      delay += 2500;
    }
    saveState();
    addActivity(`Seller campaign launched — ${added} leads`, 'accent');
    res.json({ ok: true, added });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* Launch buyer campaign */
app.post('/api/campaigns/buyer', async (req, res) => {
  try {
    const { leads = [], config = {} } = req.body;
    if (!leads.length) return res.status(400).json({ error: 'No leads provided' });

    if (config.persona) CFG.AI_PERSONA   = config.persona;
    if (config.company) CFG.COMPANY_NAME = config.company;

    let added = 0;
    let delay = 0;
    for (const lead of leads) {
      const phone = normalizePhone(lead.phone || lead);
      if (!phone || STATE.phoneIndex[phone]) continue;

      const id = uid();
      const buyer = {
        id, phone,
        name:     lead.name || fmtPhone(phone),
        status:   'new',
        score:    50,
        interest: 'Unknown',
        followups: 0,
        msgs: [],
        offerHistory: [],
        contractId: config.contractId || null,
        feeMin: parseInt(config.feeMin) || 8000,
        feeMax: parseInt(config.feeMax) || 15000,
        aiPaused: false,
        negotiationActive: false,
        ts: nowTs(),
      };
      STATE.buyers[id] = buyer;
      STATE.phoneIndex[phone] = { type: 'buyer', id };
      added++;

      const capId = id;
      setTimeout(() => {
        const b = STATE.buyers[capId];
        if (b) launchBuyerOutreach(b).catch(console.error);
      }, delay);
      delay += 2500;
    }
    saveState();
    addActivity(`Buyer campaign launched — ${added} leads`, 'accent');
    res.json({ ok: true, added });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* Set price range & activate seller negotiation */
app.post('/api/sellers/:id/price', async (req, res) => {
  try {
    const seller = STATE.sellers[req.params.id];
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const { priceMin, priceMax, priceLowball, priceNotes } = req.body;
    if (!priceMin || !priceMax || parseInt(priceMin) >= parseInt(priceMax)) {
      return res.status(400).json({ error: 'Invalid price range — min must be less than max' });
    }
    seller.priceMin     = parseInt(priceMin);
    seller.priceMax     = parseInt(priceMax);
    seller.priceLowball = parseInt(priceLowball) || parseInt(priceMin);
    seller.priceNotes   = priceNotes || '';
    saveState();

    await activateNegotiation(seller);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* Send contract notification SMS to seller */
app.post('/api/sellers/:id/contract', async (req, res) => {
  try {
    const seller = STATE.sellers[req.params.id];
    if (!seller) return res.status(404).json({ error: 'Seller not found' });

    const method = req.body.deliveryMethod || 'sms';
    const methodLabel = method === 'sms' ? 'SMS DocuSign link' : method === 'email' ? 'email' : 'SMS + email';
    const fname = (seller.name || '').split(' ')[0] || 'there';

    const msg =
      `Wonderful news, ${fname}! Your purchase agreement is being sent via ${methodLabel} now. ` +
      `Please review, sign, and return at your convenience — don't hesitate to reach out with any questions. ` +
      `We're here every step of the way and look forward to a smooth closing!`;

    await sendSMS(seller.phone, msg);
    appendMsg(seller, 'ai', msg, 'sent');
    seller.contractSent = true;
    addActivity(`Contract confirmation SMS sent → ${seller.name}`, 'green');
    saveState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Send assignment contract notification SMS to buyer */
app.post('/api/buyers/:id/contract', async (req, res) => {
  try {
    const buyer = STATE.buyers[req.params.id];
    if (!buyer) return res.status(404).json({ error: 'Buyer not found' });

    const fname = (buyer.name || '').split(' ')[0] || 'there';
    const msg =
      `${fname}, your assignment contract is on its way! ` +
      `Please review all terms carefully and sign at your convenience. ` +
      `Our title company will be reaching out shortly to coordinate the closing — thank you for doing business with us!`;

    await sendSMS(buyer.phone, msg);
    appendMsg(buyer, 'ai', msg, 'sent');
    buyer.contractSent = true;
    addActivity(`Assignment contract confirmation sent → ${buyer.name}`, 'green');
    saveState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Owner sends manual message */
app.post('/api/leads/:type/:id/message', async (req, res) => {
  try {
    const { type, id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });

    const entity = type === 'seller' ? STATE.sellers[id] : STATE.buyers[id];
    if (!entity) return res.status(404).json({ error: 'Lead not found' });

    await sendSMS(entity.phone, message);
    appendMsg(entity, 'owner', message, 'sent');
    saveState();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Remove lead from pipeline */
app.delete('/api/leads/:type/:id', (req, res) => {
  const { type, id } = req.params;
  cancelFollowup(id);
  if (type === 'seller' && STATE.sellers[id]) {
    STATE.sellers[id].status    = 'lost';
    STATE.sellers[id].removedAt = nowTs();
    STATE.sellers[id].aiPaused  = true;
  } else if (type === 'buyer' && STATE.buyers[id]) {
    STATE.buyers[id].status   = 'cold';
    STATE.buyers[id].aiPaused = true;
  }
  saveState();
  res.json({ ok: true });
});

/* Pause / unpause AI for a lead */
app.post('/api/leads/:type/:id/pause', (req, res) => {
  const { type, id } = req.params;
  const paused = !!req.body.paused;
  const entity = type === 'seller' ? STATE.sellers[id] : STATE.buyers[id];
  if (!entity) return res.status(404).json({ error: 'Not found' });
  entity.aiPaused = paused;
  if (paused) {
    cancelFollowup(id);
  } else {
    if (type === 'seller') scheduleSellerFollowup(id);
    else scheduleBuyerFollowup(id);
  }
  saveState();
  res.json({ ok: true });
});

/* ─────────────────────────────────────────────
   TWILIO WEBHOOK — Incoming SMS
───────────────────────────────────────────── */
app.post('/api/webhook/twilio', async (req, res) => {
  // Respond immediately — Twilio requires a response within 15 seconds
  res.type('text/xml').send('<Response></Response>');

  const from   = (req.body.From        || '').trim();
  const body   = (req.body.Body        || '').trim();
  const status = (req.body.MessageStatus || '').trim();
  const smsSid = (req.body.SmsSid || req.body.MessageSid || '').trim();

  // Handle delivery status callbacks (no body for these)
  if (status && !body) {
    if (status === 'delivered')                       STATE.smsStats.deliv++;
    else if (status === 'failed' || status === 'undelivered') STATE.smsStats.fail++;
    saveState();
    return;
  }

  if (!from || !body) return;

  console.log(`[Webhook] Inbound from ${from}: "${body.slice(0, 80)}"`);
  STATE.smsStats.recv++;
  saveState();

  // Lookup by phone
  const normFrom = normalizePhone(from);
  const entry    = STATE.phoneIndex[normFrom] || STATE.phoneIndex[from];

  if (!entry) {
    console.warn(`[Webhook] Unknown number ${from} — no matching lead`);
    return;
  }

  try {
    if (entry.type === 'seller') {
      const seller = STATE.sellers[entry.id];
      if (seller) await handleSellerSMS(seller, body);
    } else if (entry.type === 'buyer') {
      const buyer = STATE.buyers[entry.id];
      if (buyer) await handleBuyerSMS(buyer, body);
    }
  } catch (e) {
    console.error(`[Webhook] Handler error: ${e.message}`);
  }
});

/* ─────────────────────────────────────────────
   GLOBAL ERROR HANDLING
───────────────────────────────────────────── */
process.on('uncaughtException', e => console.error('[Uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[Unhandled]', e));

/* ─────────────────────────────────────────────
   START
───────────────────────────────────────────── */
loadState();

app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║        DealFlow AI — Backend Server  v2.0          ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log(`  Port    : ${PORT}`);
  console.log(`  Mode    : ${isProduction() ? '🟢 PRODUCTION (Twilio + Claude Live)' : '🟡 DEMO (simulated — add credentials in Settings)'}`);
  console.log(`  Webhook : http://localhost:${PORT}/api/webhook/twilio`);
  console.log('  Docs    : Open dealflow_ai_platform.html → SMS Gateway settings');
  console.log('────────────────────────────────────────────────────\n');
});

python3 << 'PYEOF'
with open('/home/claude/dealflow/dealflow_ai_platform.html', 'r') as f:
    content = f.read()

old_end = '''document.getElementById('ai-persona')?.addEventListener('input', refreshScriptPreview);
document.getElementById('company-name')?.addEventListener('input', refreshScriptPreview);
document.getElementById('msg-tone')?.addEventListener('change', refreshScriptPreview);
</script>
</body>
</html>'''

new_end = '''document.getElementById('ai-persona')?.addEventListener('input', refreshScriptPreview);
document.getElementById('company-name')?.addEventListener('input', refreshScriptPreview);
document.getElementById('msg-tone')?.addEventListener('change', refreshScriptPreview);

/* ══════════════════════════════════════════════════════════
   PRODUCTION ADDITIONS — v2.1
   Manual contract, CSV export, notification dismiss,
   reinstate, seller detail view, auto-reconnect, analytics
══════════════════════════════════════════════════════════ */

/* ── CSV Export ── */
function exportCSV(type){
  let rows, headers;
  try {
    if(type==='sellers'){
      headers=['Name','Phone','Address','Status','Score','Follow-ups','Agreed Price','Messages','Added'];
      rows=STATE.sellers.map(s=>[s.name,s.phone,s.address||'',s.status,s.score,s.followups||0,
        s.agreedPrice?fmtMoney(s.agreedPrice):'',s.msgs?.length||0,
        s.ts?new Date(s.ts).toLocaleDateString():'']);
    } else if(type==='buyers'){
      headers=['Name','Phone','Status','Interest','Fee Min','Fee Max','Agreed Fee','Follow-ups','Added'];
      rows=STATE.buyers.map(b=>[b.name,b.phone,b.status,b.interest||'Unknown',
        fmtMoney(b.feeMin||0),fmtMoney(b.feeMax||0),
        b.agreedFee?fmtMoney(b.agreedFee):'',b.followups||0,
        b.ts?new Date(b.ts).toLocaleDateString():'']);
    } else if(type==='contracts'){
      const contracts=Array.isArray(STATE.contracts)?STATE.contracts:Object.values(STATE.contracts||{});
      headers=['Address','Seller','Purchase Price','Fee Min','Fee Max','Status','Added'];
      rows=contracts.map(c=>[c.address||'',c.sellerName||'',
        fmtMoney(c.purchasePrice||0),fmtMoney(c.feeMin||0),fmtMoney(c.feeMax||0),
        c.status||'',c.ts?new Date(c.ts).toLocaleDateString():'']);
    } else { showToast('Unknown export type.','error'); return; }

    const escape=v=>'"'+String(v||'').replace(/"/g,'""')+'"';
    const csv=[headers,...rows].map(r=>r.map(escape).join(',')).join('\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url;
    a.download=`dealflow_${type}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`${type.charAt(0).toUpperCase()+type.slice(1)} exported!`, 'success');
  } catch(e){
    showToast('Export failed: '+e.message,'error');
  }
}

/* ── Add Contract Manually ── */
function openAddContractModal(){
  // Populate seller select
  const sel=document.getElementById('new-contract-seller-select');
  if(sel){
    sel.innerHTML='<option value="">— No linked seller —</option>';
    STATE.sellers.filter(s=>['warm','done','negotiating'].includes(s.status)).forEach(s=>{
      sel.innerHTML+=`<option value="${s.id}">${s.name}${s.address?' — '+s.address:''}</option>`;
    });
  }
  // Auto-fill fee suggestion
  const priceInput=document.getElementById('new-contract-price');
  if(priceInput){
    priceInput.oninput=function(){
      const p=parseInt(this.value)||0;
      if(p>0){
        document.getElementById('new-contract-fee-min').value=Math.round(p*0.07);
        document.getElementById('new-contract-fee-max').value=Math.round(p*0.14);
      }
    };
  }
  openModal('addContractModal');
}

async function addContractManually(){
  const address   = document.getElementById('new-contract-address')?.value.trim();
  const sellerId  = document.getElementById('new-contract-seller-select')?.value;
  const sellerName= document.getElementById('new-contract-seller-name')?.value.trim();
  const price     = parseInt(document.getElementById('new-contract-price')?.value);
  const feeMin    = parseInt(document.getElementById('new-contract-fee-min')?.value)||0;
  const feeMax    = parseInt(document.getElementById('new-contract-fee-max')?.value)||0;

  if(!price||price<=0){ showToast('Enter a valid purchase price.','error'); return; }

  let name = sellerName;
  let linkedSeller = null;
  if(sellerId){
    linkedSeller = STATE.sellers.find(s=>s.id===sellerId);
    name = linkedSeller?.name || sellerName;
    if(address && linkedSeller) linkedSeller.address = address;
  }

  if(BACKEND.connected){
    try {
      const res=await fetch(`${BACKEND.url}/api/contracts`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sellerId:sellerId||null,address,sellerName:name,purchasePrice:price,feeMin,feeMax})
      });
      const data=await res.json();
      if(data.error) throw new Error(data.error);
      showToast('Contract added!','success');
      closeModal('addContractModal');
      setTimeout(pollBackend,500);
    } catch(e){ showToast('Failed: '+e.message,'error'); }
  } else {
    // Demo mode
    const contract={
      id:uid(),sellerId:sellerId||null,address,sellerName:name,
      purchasePrice:price,
      feeMin:feeMin||Math.round(price*0.07),
      feeMax:feeMax||Math.round(price*0.14),
      status:'pending',assignedBuyerId:null,ts:Date.now()
    };
    STATE.contracts.push(contract);
    if(linkedSeller){ linkedSeller.status='done'; linkedSeller.agreedPrice=price; }
    addActivity(`Contract added: ${address||'Property'} at ${fmtMoney(price)}`,'green');
    showToast('Contract added (demo mode)!','success');
    closeModal('addContractModal');
    updateDashboard();
    renderContracts();
    // Clear fields
    ['new-contract-address','new-contract-seller-name','new-contract-price','new-contract-fee-min','new-contract-fee-max']
      .forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  }
}

/* ── Dismiss Notification ── */
async function dismissNotification(id){
  if(!id){ return; }
  // Remove locally
  STATE.notifications=STATE.notifications.filter(n=>n.id!==id);
  updateBadges();
  renderNotifications();
  // If backend connected, sync
  if(BACKEND.connected){
    try { await fetch(`${BACKEND.url}/api/notifications/${id}`,{method:'DELETE'}); } catch(e){}
  }
}

async function dismissAllNotifications(){
  STATE.notifications=[];
  updateBadges();
  renderNotifications();
  if(BACKEND.connected){
    try { await fetch(`${BACKEND.url}/api/notifications`,{method:'DELETE'}); } catch(e){}
  }
}

/* ── Reinstate Removed Seller ── */
async function reinstateSellerUI(id){
  if(BACKEND.connected){
    try {
      const res=await fetch(`${BACKEND.url}/api/sellers/${id}/reinstate`,{method:'POST'});
      const data=await res.json();
      if(data.ok){ showToast('Seller reinstated!','success'); setTimeout(pollBackend,400); }
      else showToast('Failed: '+(data.error||'unknown'),'error');
    } catch(e){ showToast('Error: '+e.message,'error'); }
  } else {
    const s=STATE.sellers.find(x=>x.id===id);
    if(s){
      s.status='new'; s.removedAt=null; s.score=50; s.aiPaused=false; s.followups=0;
      showToast('Seller reinstated (demo).','success');
      renderProspects(); updateDashboard();
    }
  }
}

/* ── Auto-reconnect backend on disconnect ── */
let _reconnectAttempts=0;
function startAutoReconnect(){
  if(!BACKEND.url||BACKEND.connected) return;
  if(_reconnectAttempts>=5){ _reconnectAttempts=0; return; } // give up after 5 tries
  _reconnectAttempts++;
  setTimeout(async()=>{
    if(BACKEND.connected) return;
    try {
      const res=await fetch(`${BACKEND.url}/api/health`,{signal:AbortSignal.timeout(3000)});
      if(res.ok){
        const data=await res.json();
        BACKEND.connected=true; BACKEND.mode=data.mode||'demo';
        _reconnectAttempts=0;
        updateGWStatus(); startPolling();
        showToast('Backend reconnected!','success');
      } else { startAutoReconnect(); }
    } catch(e){ startAutoReconnect(); }
  }, Math.min(5000*_reconnectAttempts, 30000)); // exponential backoff up to 30s
}

// Hook into poll failure to trigger reconnect
const _origPollBackend=pollBackend;
async function pollBackend(){
  if(!BACKEND.connected||!BACKEND.url) return;
  try {
    const res=await fetch(`${BACKEND.url}/api/state`,{signal:AbortSignal.timeout(4000)});
    if(!res.ok){
      BACKEND.connected=false; updateGWStatus();
      startAutoReconnect();
      return;
    }
    const data=await res.json();
    syncFromBackend(data);
    BACKEND.lastPoll=Date.now();
    _reconnectAttempts=0;
  } catch(e){
    console.warn('[Poll]',e.message);
    if(e.name==='AbortError'||e.name==='TypeError'){
      BACKEND.connected=false; updateGWStatus();
      startAutoReconnect();
    }
  }
}

/* ── Analytics fetch from backend when connected ── */
async function fetchAndRefreshAnalytics(){
  if(!BACKEND.connected) { initCharts(); return; }
  try {
    const res=await fetch(`${BACKEND.url}/api/analytics`,{signal:AbortSignal.timeout(5000)});
    if(!res.ok){ initCharts(); return; }
    const an=await res.json();
    // Sync backend analytics into STATE for chart computation
    // (charts still computed locally since STATE is synced via pollBackend)
    initCharts();
  } catch(e){ initCharts(); }
}

/* ── Override nav to always refresh charts ── */
const _origNav=nav;
function nav(p){
  _origNav(p);
  if(p==='analytics') fetchAndRefreshAnalytics();
}

/* ── Add "Clear All Notifications" button dynamically ── */
function renderNotifications(){
  const list=document.getElementById('notif-list');
  if(!list) return;
  if(!STATE.notifications.length){
    list.innerHTML='<div style="font-size:13px;color:var(--text3);text-align:center;padding:40px">No notifications yet. Import leads to get started.</div>';
    return;
  }
  list.innerHTML=`
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn btn-sm btn-danger" onclick="dismissAllNotifications()"><i class="ti ti-trash"></i> Clear All</button>
    </div>`+
  [...STATE.notifications].reverse().map((n) => `
    <div class="notif-item notif-${n.type}" id="notif-${n.id||'x'}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div class="notif-title"><i class="ti ${n.type==='success'?'ti-check':n.type==='warning'?'ti-alert-circle':n.type==='danger'?'ti-user-x':'ti-info-circle'}"></i> ${n.title}</div>
        <button class="btn btn-xs" onclick="dismissNotification('${n.id||''}')" style="padding:2px 6px;font-size:10px;opacity:0.6">✕</button>
      </div>
      <div class="notif-body">${n.body}</div>
      ${n.action&&n.actionFn?`<div class="notif-actions"><button class="btn btn-sm" onclick="(STATE.notifications.find(x=>x.id==='${n.id}')?.actionFn||function(){})()">${n.action} →</button></div>`:''}
    </div>`).join('');
}

/* ── Defensive null check for fmtPhone ── */
const _origFmtPhone=fmtPhone;
function fmtPhone(raw){
  if(!raw||typeof raw!=='string') return raw||'';
  return _origFmtPhone(raw);
}

/* ── Contracts page: use array OR object for STATE.contracts ── */
const _origRenderContracts=renderContracts;
function renderContracts(){
  // Normalize contracts to array regardless of backend vs demo mode
  if(STATE.contracts && !Array.isArray(STATE.contracts)){
    STATE.contracts=Object.values(STATE.contracts);
  }
  _origRenderContracts();
}

/* ── populateBuyerContractSelect: handles array + object ── */
const _origPopBCS=populateBuyerContractSelect;
function populateBuyerContractSelect(){
  if(STATE.contracts && !Array.isArray(STATE.contracts)){
    STATE.contracts=Object.values(STATE.contracts);
  }
  _origPopBCS();
}

/* ── Add Contract to buyer contract dropdown on intake page ── */
function refreshBuyerContractSelect(){
  const contracts=Array.isArray(STATE.contracts)?STATE.contracts:Object.values(STATE.contracts||{});
  const sel=document.getElementById('buyer-contract-select');
  if(!sel) return;
  sel.innerHTML=contracts.length
    ?contracts.map(c=>`<option value="${c.id}">${c.address||'Property'} — ${fmtMoney(c.purchasePrice||0)}</option>`).join('')
      +'<option value="">No specific contract (prospecting)</option>'
    :'<option value="">No contracts yet — build seller pipeline first</option>';
}

/* ── Seller score in conversations better detail ── */
const _origSelectConvo=selectConvo;
function selectConvo(id,type){
  _origSelectConvo(id,type);
  // Refresh convo list to highlight selection
  renderConvoList();
}

/* ── Ensure contracts sync works from backend (object → array) ── */
const _origSyncFromBackend=syncFromBackend;
function syncFromBackend(data){
  _origSyncFromBackend(data);
  // Keep contracts as array in STATE always
  if(STATE.contracts && !Array.isArray(STATE.contracts)){
    STATE.contracts=Object.values(STATE.contracts);
  }
  // Refresh buyer contract select if on intake page
  refreshBuyerContractSelect();
}

/* ── Stage label helper for seller table ── */
function getStageLabel(seller){
  if(seller.status==='new') return seller.followups>1?`Follow-up ${seller.followups}`:'Cold Outreach';
  if(seller.status==='warm') return '⚡ Set Price Range';
  if(seller.status==='negotiating') return `🤝 Negotiating${seller.lastAiOffer?' @ '+fmtMoney(seller.lastAiOffer):''}`;
  if(seller.status==='done') return seller.contractSent?'✅ Contract Sent':'📄 Send Contract';
  if(seller.status==='cold') return 'Max Follow-ups';
  if(seller.status==='lost') return 'Not Interested';
  return '—';
}

/* ── Enhanced renderProspects with stage column ── */
const _origRenderProspects=renderProspects;
function renderProspects(){
  const all=STATE.sellers;
  const active=all.filter(s=>s.status!=='lost');
  const flagged=all.filter(s=>s.status==='warm');
  const removed=all.filter(s=>s.status==='lost');
  document.getElementById('tc-all').textContent=active.length;
  document.getElementById('tc-flagged').textContent=flagged.length;
  document.getElementById('tc-removed').textContent=removed.length;

  document.getElementById('seller-table-body').innerHTML=active.map(s=>`
    <tr>
      <td><div class="score-ring ${scoreClass(s.score)}">${s.score}</div></td>
      <td><div style="font-weight:500">${s.name||'Unknown'}</div><div style="font-size:10px;color:var(--text3)">${s.phone||''}</div></td>
      <td style="font-size:11px;color:var(--text2)">${s.address||'—'}</td>
      <td><span class="badge ${statusMap[s.status]||'badge-cold'}">${statusLabel[s.status]||s.status}</span></td>
      <td style="font-size:11px;color:var(--text2)">${getStageLabel(s)}</td>
      <td style="font-size:11px;color:var(--text3)">${s.msgs&&s.msgs.length?timeAgo(s.msgs.slice(-1)[0].ts):'—'}</td>
      <td><div style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn btn-xs" onclick="selectConvo('${s.id}','seller');nav('conversations')" title="View Conversation"><i class="ti ti-message-2"></i></button>
        ${s.status==='warm'?`<button class="btn btn-xs btn-success" onclick="openPriceModalForSeller('${s.id}')" title="Set Price Range"><i class="ti ti-currency-dollar"></i> Price</button>`:''}
        ${s.status==='negotiating'?`<span class="badge badge-negotiating" style="font-size:9px">AI Negotiating</span>`:''}
        ${s.status==='done'&&!s.contractSent?`<button class="btn btn-xs btn-primary" onclick="openContractModal('${s.id}')" title="Send Contract"><i class="ti ti-file-text"></i> Contract</button>`:''}
        ${s.status==='done'&&s.contractSent?`<span style="font-size:11px;color:var(--green)"><i class="ti ti-check"></i> Sent</span>`:''}
        ${s.status==='lost'?`<button class="btn btn-xs" onclick="reinstateSellerUI('${s.id}')" title="Reinstate"><i class="ti ti-refresh"></i></button>`:''}
      </div></td>
    </tr>`).join('')||'<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">No sellers yet. Import leads to get started.</td></tr>';

  document.getElementById('flagged-list').innerHTML=flagged.length?flagged.map(s=>`
    <div style="display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:12px;font-weight:500">${s.name} — ${s.address||'No address'}</div>
        <div style="font-size:11px;color:var(--text2);margin-top:2px">${(s.msgs||[]).slice(-1)[0]?.text?.slice(0,80)||'—'}${(s.msgs||[]).slice(-1)[0]?.text?.length>80?'...':''}</div>
      </div>
      <button class="btn btn-sm btn-success" onclick="openPriceModalForSeller('${s.id}')"><i class="ti ti-currency-dollar"></i> Set Range</button>
    </div>`).join(''):'<div style="color:var(--text3);font-size:12px;padding:12px 0">No leads awaiting price range.</div>';

  document.getElementById('removed-list').innerHTML=removed.length?removed.map(s=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border);font-size:12px">
      <div><span style="font-weight:500">${s.name}</span><span style="color:var(--text3)"> — ${s.address||'No address'}</span></div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11px;color:var(--text3)">${s.removedAt?timeAgo(s.removedAt):'—'}</span>
        <button class="btn btn-xs" onclick="reinstateSellerUI('${s.id}')"><i class="ti ti-refresh"></i> Reinstate</button>
      </div>
    </div>`).join(''):'<div style="color:var(--text3);font-size:12px;padding:8px 0">No removed leads.</div>';
}

/* ── Contracts page: also show pitch buyer button ── */
const _origRenderContracts2=_origRenderContracts;

/* ── Dashboard: fix activity color rendering ── */
const _origUpdateDashboard=updateDashboard;
function updateDashboard(){
  _origUpdateDashboard();
  // Re-render activity with fixed colors
  const acts=STATE.activity||[];
  const actEl=document.getElementById('dash-activity');
  if(actEl&&acts.length){
    actEl.innerHTML=acts.slice(-6).reverse().map(a=>`
      <div class="activity-item">
        <div class="act-icon" style="${activityColorStyle(a.color||'blue')}"><i class="ti ti-circle-dot"></i></div>
        <div><div class="act-text">${a.text}</div><div class="act-time">${timeAgo(a.ts||Date.now())}</div></div>
      </div>`).join('');
  }
}

/* ── Onload: refresh buyer contract select ── */
document.addEventListener('DOMContentLoaded',()=>{
  refreshBuyerContractSelect();
});
</script>
</body>
</html>'''

if old_end in content:
    content = content.replace(old_end, new_end)
    print("New JS functions added successfully")
else:
    print("ERROR: Could not find end of script")
    # Debug
    idx = content.find("</script>")
    print(f"</script> found at index: {idx}")

with open('/home/claude/dealflow/dealflow_ai_platform.html', 'w') as f:
    f.write(content)
PYEOF