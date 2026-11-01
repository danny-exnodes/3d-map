import { APIConnectionError, AuthenticationError } from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import {
  Advisor,
  type AdvisorClient,
  AdvisorError,
  anthropicKey,
  echoableContent,
  FALLBACK_BETA,
  REFUSAL_TEXT,
  runTool,
} from '../src/land/advisor';
import { buildDossier } from '../src/land/dossier';
import { marketStats, nearby } from '../src/land/market';
import type { Listing, Parcel } from '../src/land/types';
import { defaultAssumptions, valueParcel } from '../src/land/valuation';

const LON = 106.7;
const LAT = 10.78;

const parcel: Parcel = {
  id: 'p1',
  source: 'osm',
  ring: [
    [LON, LAT],
    [LON + 5 / 109000, LAT],
    [LON + 5 / 109000, LAT + 16 / 110600],
    [LON, LAT + 16 / 110600],
  ],
  landCode: 'ODT',
  landCodeGuessed: true,
  metrics: { area: 80, perimeter: 42, edges: [], frontage: 5, depth: 16, shape: 'vuong', streetDistance: 5 },
};

// Five listings ~150–250 m north of the parcel, all mặt tiền / sổ riêng like the subject.
const listings: Listing[] = [100, 110, 120, 130, 115].map((tr, i) => ({
  id: `L${i}`,
  source: 'chotot',
  lon: LON,
  lat: LAT + (150 + i * 25) / 110600,
  price: tr * 1e6 * 80,
  size: 80,
  pricePerM2: tr * 1e6,
  width: 5,
  legal: 'so-rieng',
  access: 'mat-tien',
  corner: false,
  landType: 'Đất thổ cư',
  time: Date.UTC(2026, 9, 1),
  url: `https://www.nhatot.com/${i}.htm`,
}));

function context(client?: AdvisorClient) {
  const assumptions = defaultAssumptions(parcel);
  const comps = nearby(listings, LON, LAT, 1000);
  const valuation = valueParcel(parcel, comps, assumptions);
  const dossier = buildDossier({ parcel, comparables: comps, stats: marketStats(comps), valuation, radiusM: 1000 });
  return { dossier, parcel, listings, assumptions, client };
}

const msg = (content: unknown[], stop_reason: BetaMessage['stop_reason']): BetaMessage =>
  ({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, usage: {} }) as unknown as BetaMessage;

/** Scripted stand-in for client.beta.messages: replays messages, streams their text, records requests. */
function fakeClient(script: (BetaMessage | Error)[]) {
  const calls: BetaMessageStreamParams[] = [];
  const client: AdvisorClient = {
    beta: {
      messages: {
        stream(body) {
          calls.push(structuredClone(body));
          const next = script.shift();
          let listener: ((d: string) => void) | null = null;
          return {
            on(_event, cb) {
              listener = cb;
              return this;
            },
            async finalMessage() {
              if (!next) throw new Error('script exhausted');
              if (next instanceof Error) throw next;
              for (const b of next.content) if (b.type === 'text') listener?.(b.text);
              return next;
            },
          };
        },
      },
    },
  };
  return { client, calls };
}

const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
const revalueCall = {
  type: 'tool_use',
  id: 'tu_1',
  name: 'revalue',
  input: { access: 'mat-tien', corner: false, legal: 'giay-tay', roadWideningShare: 0, askDiscount: 0.08 },
};

describe('AI advisor (#39)', () => {
  it('runs the tool loop: tool_use → tool_result → final text, with the expected request', async () => {
    const { client, calls } = fakeClient([
      msg([thinking, revalueCall], 'tool_use'),
      msg([{ type: 'text', text: '## Tóm tắt giá\nGiấy tay làm giảm khoảng 30%.' }], 'end_turn'),
    ]);
    const adv = new Advisor(context(client));
    let streamed = '';
    const answer = await adv.ask('Nếu chỉ có giấy tay thì giá thế nào?', (d) => (streamed += d));

    expect(answer).toBe('## Tóm tắt giá\nGiấy tay làm giảm khoảng 30%.');
    expect(streamed).toBe(answer);
    expect(calls).toHaveLength(2);

    const req = calls[0];
    expect(req).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
    });
    expect(req.tool_choice).toBeUndefined();
    expect(req.tools!.map((t) => ('name' in t ? t.name : ''))).toEqual(['get_dossier', 'revalue', 'get_comparables']);
    for (const t of req.tools!) expect(t).toMatchObject({ strict: true, input_schema: { additionalProperties: false } });
    // The system prompt is identical across calls (cacheable) and does not embed the dossier.
    expect(calls[1].system).toEqual(req.system);
    expect(JSON.stringify(req.system)).not.toContain('tinymap.valuation');

    const second = calls[1].messages;
    expect(second).toHaveLength(3);
    expect(second[0]).toEqual({ role: 'user', content: 'Nếu chỉ có giấy tay thì giá thế nào?' });
    // Assistant turn echoed unchanged, thinking block included.
    expect(second[1]).toEqual({ role: 'assistant', content: [thinking, revalueCall] });
    const results = second[2].content as { type: string; tool_use_id: string; content: string; is_error?: boolean }[];
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1' });
    expect(results[0].is_error).toBeUndefined();
    const out = JSON.parse(results[0].content);
    expect(out.assumptions.legal).toBe('giay-tay');
    expect(out.changeVsDossier).toBeCloseTo(-0.3, 2);

    expect(adv.history).toHaveLength(4);
    expect(adv.history[3].role).toBe('assistant');
  });

  it('keeps history for follow-up questions', async () => {
    const { client, calls } = fakeClient([msg([{ type: 'text', text: 'Một' }], 'end_turn'), msg([{ type: 'text', text: 'Hai' }], 'end_turn')]);
    const adv = new Advisor(context(client));
    await adv.ask('Câu 1', () => {});
    expect(await adv.ask('Câu 2', () => {})).toBe('Hai');
    expect(calls[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(adv.history).toHaveLength(4);
  });

  it('returns is_error tool results for bad input instead of running the tool', () => {
    const ctx = context();
    expect(runTool(ctx, 'revalue', { ...revalueCall.input, access: 'biet-thu' }).isError).toBe(true);
    expect(runTool(ctx, 'revalue', { ...revalueCall.input, roadWideningShare: 2 }).isError).toBe(true);
    expect(runTool(ctx, 'get_comparables', { radiusM: -5 }).isError).toBe(true);
    expect(runTool(ctx, 'nope', {}).isError).toBe(true);
    const ok = JSON.parse(runTool(ctx, 'get_comparables', { radiusM: 200 }).content);
    expect(ok.comparables.length).toBeGreaterThan(0);
    expect(ok.comparables.every((c: { distance: number }) => c.distance <= 200)).toBe(true);
    expect(JSON.parse(runTool(ctx, 'get_dossier', {}).content).schema).toBe('tinymap.valuation/v1');
  });

  it('shows a Vietnamese message on refusal', async () => {
    const { client } = fakeClient([msg([], 'refusal')]);
    const adv = new Advisor(context(client));
    expect(await adv.ask('?', () => {})).toBe(REFUSAL_TEXT);
    // Empty refused turn is not echoed (an empty assistant message would be a 400).
    expect(adv.history).toHaveLength(1);
  });

  it('does not run a tool call cut off at max_tokens', async () => {
    const { client, calls } = fakeClient([msg([thinking, revalueCall], 'max_tokens')]);
    const adv = new Advisor(context(client));
    const answer = await adv.ask('?', () => {});
    expect(answer).toMatch(/bị cắt/);
    expect(calls).toHaveLength(1);
    expect(adv.history.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('maps SDK errors to Vietnamese messages and rolls back history', async () => {
    const { client } = fakeClient([new APIConnectionError({ message: 'offline' })]);
    const adv = new Advisor(context(client));
    await expect(adv.ask('?', () => {})).rejects.toMatchObject({ kind: 'offline' });
    expect(adv.history).toHaveLength(0);

    const auth = fakeClient([new AuthenticationError(401, undefined, 'bad key', new Headers())]);
    const e = await new Advisor(context(auth.client)).ask('?', () => {}).catch((x) => x);
    expect(e).toBeInstanceOf(AdvisorError);
    expect(e.message).toMatch(/^Key Anthropic không hợp lệ/);
  });

  it('asks for a key when none is stored', async () => {
    expect(anthropicKey()).toBeNull();
    await expect(new Advisor(context()).ask('?', () => {})).rejects.toMatchObject({ kind: 'no-key' });
  });

  it('drops pre-fallback thinking/tool_use blocks before echoing', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 's' },
      { type: 'text', text: 'partial' },
      { type: 'tool_use', id: 'x', name: 'get_dossier', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      { type: 'thinking', thinking: '', signature: 't' },
      { type: 'text', text: 'rest' },
    ] as unknown as BetaContentBlock[];
    expect(echoableContent(content).map((b) => b.type)).toEqual(['text', 'fallback', 'thinking', 'text']);
    const plain = [thinking] as unknown as BetaContentBlock[];
    expect(echoableContent(plain)).toBe(plain);
  });
});
