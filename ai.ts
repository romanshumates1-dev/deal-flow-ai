// src/services/ai.ts
// Anthropic Claude wrapper with org-level API key support, structured output,
// and comprehensive prompt library for the real estate workflow.

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env';
import { decryptSafe } from '../utils/crypto';
import { logger } from '../utils/logger';

interface OrgAiConfig {
  anthropicKey?: string | null;  // stored encrypted
  aiPersona?: string;
  companyName?: string;
  msgTone?: string;
}

type MessageParam = { role: 'user' | 'assistant'; content: string };

interface CallClaudeOptions {
  org: OrgAiConfig;
  system: string;
  messages: MessageParam[];
  maxTokens?: number;
}

// ─── Client resolution ────────────────────────────────────────────────────

function resolveClient(org: OrgAiConfig): Anthropic | null {
  const key = org.anthropicKey ? decryptSafe(org.anthropicKey) : env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

// ─── Core call ────────────────────────────────────────────────────────────

export async function callClaude(options: CallClaudeOptions): Promise<string | null> {
  const client = resolveClient(options.org);
  if (!client) {
    logger.warn('No Anthropic API key configured — AI call skipped');
    return null;
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: options.maxTokens ?? 400,
      system: options.system,
      messages: options.messages,
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim();

    return text || null;
  } catch (err: any) {
    logger.error({ err: err.message, status: err.status }, 'Anthropic API error');
    return null;
  }
}

// ─── Intent classification ────────────────────────────────────────────────

export type SellerIntent = 'interested' | 'not_interested' | 'faq' | 'unclear';
export type NegotiationIntent = 'agreed' | 'counter' | 'firm_no' | 'unclear';
export type BuyerIntent = 'interested' | 'declined' | 'counter' | 'unclear';

const NOT_INTERESTED = ['not interested','no thanks','stop','unsubscribe','dont contact','do not contact',
  'remove me','opt out','wrong number','not selling','leave me alone','no deal','not for sale'];
const INTERESTED = ['interested','tell me more','how much','make me an offer','what is your offer',
  'maybe','possibly','open to','sure','go ahead','sounds good','how does it work'];
const FAQ_TRIGGERS = ['how long','how does','what is','do i need','commission','fees','realtor',
  'repairs','as is','closing','timeline','closing costs'];

export async function classifySellerIntent(
  message: string,
  org: OrgAiConfig
): Promise<SellerIntent> {
  const lower = message.toLowerCase();
  if (NOT_INTERESTED.some(k => lower.includes(k))) return 'not_interested';
  if (INTERESTED.some(k => lower.includes(k)))      return 'interested';
  if (FAQ_TRIGGERS.some(k => lower.includes(k)))    return 'faq';

  const result = await callClaude({
    org,
    system: 'You are a classifier for real estate SMS responses. Reply with exactly one word.',
    messages: [{
      role: 'user',
      content: `Classify this message from a homeowner into one of: interested, not_interested, faq, unclear\n\nMessage: "${message}"\n\nClassification:`,
    }],
    maxTokens: 5,
  });

  const clean = (result || 'unclear').toLowerCase().replace(/[^a-z_]/g, '') as SellerIntent;
  return ['interested', 'not_interested', 'faq', 'unclear'].includes(clean) ? clean : 'unclear';
}

export function extractPriceFromMessage(message: string, minimumAmount = 1000): number | null {
  // Match $150k, $150,000, 150000, 150K
  const patterns = [
    /\$?([\d,]+)\s*k\b/i,          // 150k
    /\$?([\d,]{3,})\b/,            // $150,000 or 150000
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      let n = parseInt(match[1].replace(/,/g, ''), 10);
      if (/k\b/i.test(message.slice((match.index || 0) + match[0].length - 2, (match.index || 0) + match[0].length + 2))) {
        n *= 1000;
      }
      if (n >= minimumAmount) return n;
    }
  }
  return null;
}

export function classifyNegotiationIntent(
  message: string,
  currentOffer: number
): { intent: NegotiationIntent; price: number | null } {
  const lower = message.toLowerCase();
  const price = extractPriceFromMessage(message);

  const AGREED = ['deal','i accept','accepted','i agree','lets do it','sounds good','works for me',
    'you got it','we have a deal','agreed','yes deal','done deal'];
  const WALK   = ['forget it','never mind','not happening','ridiculous','insulting','no way',
    'final answer','take it or leave'];

  if (AGREED.some(k => lower.includes(k)))  return { intent: 'agreed',   price: price || currentOffer };
  if (WALK.some(k => lower.includes(k)) && !price) return { intent: 'firm_no', price: null };
  if (price)                                return { intent: 'counter',  price };
  return { intent: 'unclear', price: null };
}

// ─── System prompts ───────────────────────────────────────────────────────

export function buildSellerQualifyPrompt(
  org: OrgAiConfig,
  sellerName?: string,
  address?: string
): string {
  const persona  = org.aiPersona   || 'Alex';
  const company  = org.companyName || 'our company';
  const tone     = org.msgTone     || 'professional';

  return `You are ${persona}, a ${tone} real estate acquisition specialist at ${company}. You are texting the property owner${sellerName ? ' ' + sellerName : ''} about possibly purchasing their property${address ? ' at ' + address : ''}.

YOUR ROLE: Qualify motivated sellers and determine their interest in a cash sale.

ABSOLUTE RULES:
- Never reveal you are an AI. You are ${persona} from ${company}.
- Never quote a price until you receive specific negotiation instructions.
- Keep SMS responses to 3–5 sentences maximum.
- Harvard-level grammar, warm, ${tone}, never pushy.
- Answer FAQs clearly: all-cash, 7–14 day close, no repairs, no realtor fees, no commissions, no inspection contingencies.
- If they seem interested, ask about property condition and ideal timeline.
- Never share personal information about the seller.`;
}

export function buildSellerNegotiatePrompt(
  org: OrgAiConfig,
  params: {
    sellerName?: string;
    address?: string;
    openingOffer: number;
    minOffer: number;
    maxOffer: number;
    offerHistory: Array<{ party: 'AI' | 'PROSPECT'; amount: number }>;
    notes?: string;
  }
): string {
  const persona = org.aiPersona || 'Alex';
  const company = org.companyName || 'our company';
  const fmt = (n: number) => `$${n.toLocaleString()}`;
  const history = params.offerHistory
    .map(o => `${o.party === 'AI' ? 'Our offer' : 'Their ask'}: ${fmt(o.amount)}`)
    .join(' → ') || 'None yet';

  return `You are ${persona} from ${company}, negotiating to purchase${params.sellerName ? ' ' + params.sellerName + "'s" : ' a'} property${params.address ? ' at ' + params.address : ''}.

PRICE CONSTRAINTS — NON-NEGOTIABLE:
• Opening offer: ${fmt(params.openingOffer)}
• Minimum: ${fmt(params.minOffer)}
• ABSOLUTE MAXIMUM: ${fmt(params.maxOffer)} — DO NOT EXCEED THIS UNDER ANY CIRCUMSTANCES
• Offer history: ${history}

NEGOTIATION STRATEGY:
1. Open at the opening offer. Justify with: market comps, repair costs, as-is risk, speed/certainty of cash close.
2. Concede in small steps (5–10% max per round). Never concede more than twice without reciprocation.
3. Always highlight: all-cash, no realtor fees, no repairs, 7–14 day close.
4. If counter exceeds your max: politely hold firm, explain business constraints.
5. Once at max with no deal: gracefully walk away, leave door open for future.
6. 3–5 sentences max. Professional, confident, never desperate.

Additional notes: ${params.notes || 'None'}`;
}

export function buildBuyerPitchPrompt(
  org: OrgAiConfig,
  params: {
    buyerName?: string;
    propertyAddress?: string;
    purchasePrice?: number;
    feeMin: number;
    feeMax: number;
  }
): string {
  const persona = org.aiPersona || 'Alex';
  const company = org.companyName || 'our company';
  const fmt = (n: number) => `$${n.toLocaleString()}`;

  const propDetail = params.propertyAddress
    ? `${params.propertyAddress}${params.purchasePrice ? ` (under contract at ${fmt(params.purchasePrice)})` : ''}`
    : 'an exclusive off-market investment opportunity';

  return `You are ${persona} from ${company}, pitching an assignment contract to real estate investor ${params.buyerName || 'a cash buyer'}.

DEAL DETAILS:
• Property: ${propDetail}
• Assignment fee range: ${fmt(params.feeMin)} – ${fmt(params.feeMax)}

YOUR ROLE: Present this as a compelling investment. Answer all property/process questions. Pitch the deal's merits (below market value, ARV upside, fast close, zero contingencies). Use professional investor language. SMS: 3–5 sentences max. Never say you are an AI.`;
}

export function buildBuyerNegotiatePrompt(
  org: OrgAiConfig,
  params: {
    buyerName?: string;
    propertyAddress?: string;
    feeMin: number;
    feeMax: number;
    offerHistory: Array<{ party: 'AI' | 'PROSPECT'; amount: number }>;
  }
): string {
  const persona = org.aiPersona || 'Alex';
  const company = org.companyName || 'our company';
  const fmt = (n: number) => `$${n.toLocaleString()}`;
  const history = params.offerHistory
    .map(o => `${o.party === 'AI' ? 'Our ask' : 'Buyer offered'}: ${fmt(o.amount)}`)
    .join(' → ') || 'None yet';

  return `You are ${persona} from ${company}, negotiating an assignment fee with ${params.buyerName || 'a buyer'} for ${params.propertyAddress || 'the property'}.

FEE CONSTRAINTS — NON-NEGOTIABLE:
• Minimum fee (NEVER go below this): ${fmt(params.feeMin)}
• Maximum ask: ${fmt(params.feeMax)}
• Offer history: ${history}

STRATEGY: Justify fee with the deal's profit potential, ARV upside, exclusive nature, fast close. Concede slowly toward minimum. Never go below ${fmt(params.feeMin)}. Keep SMS to 3–5 sentences.`;
}
