/**
 * AI investment advisor for a valued parcel (#39).
 *
 * Runs entirely in the browser with the user's own Anthropic key (stored in localStorage, never
 * logged, never put in a URL). The SDK is loaded with a dynamic import inside `ask()` so it is
 * code-split and costs nothing until the user opens the advisor.
 *
 * Design notes:
 *  - Manual agentic loop: the model reads the dossier and re-runs the valuation through three
 *    client tools. Forced tool_choice is rejected on claude-opus-5-5, so the system prompt
 *    steers it to call get_dossier first and tool_choice stays auto; `strict: true` keeps the
 *    tool inputs schema-valid, and we still validate before running anything.
 *  - The system prompt and tool list never change during a session, so the cached prefix holds;
 *    the dossier reaches the model through get_dossier instead of the system prompt.
 *  - Every assistant turn is appended to history exactly as returned (thinking blocks must be
 *    passed back unchanged), except the parts the server-side fallback docs say to drop.
 */
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ValuationDossier } from './dossier';
import { marketStats, nearby } from './market';
import type { Access, LegalStatus, Listing, Parcel } from './types';
import { type Assumptions, ringCenter, type Valuation, valueParcel } from './valuation';

const KEY = 'tinymap:anthropicKey';

export function anthropicKey(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setAnthropicKey(k: string | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (k) localStorage.setItem(KEY, k);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export const ADVISOR_MODEL = 'claude-opus-5-5';
/** Thinking counts toward max_tokens on this model; 16k leaves room for a long Vietnamese answer. */
export const ADVISOR_MAX_TOKENS = 16000;
/** `fallbacks: 'default'` needs exactly this header (the array form uses -2026-06-01). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const MAX_ITERATIONS = 6;

export const SYSTEM_PROMPT = `Bạn là cố vấn đầu tư bất động sản, chuyên về đất ở Việt Nam. Người dùng là nhà đầu tư cá nhân đang xem một thửa đất trên ứng dụng Tiny Map.

Dữ liệu:
- Trước khi trả lời câu hỏi đầu tiên, luôn gọi công cụ get_dossier để đọc hồ sơ định giá (thửa đất, tin rao lân cận, kết quả định giá, giả định).
- Dùng revalue khi người dùng hỏi "nếu ... thì sao" về vị trí (mặt tiền/hẻm), lô góc, pháp lý, lộ giới hoặc mức chiết khấu giá rao. Dùng get_comparables khi cần xem thị trường ở bán kính khác.
- Chỉ dùng con số có trong hồ sơ hoặc kết quả công cụ. Không tự bịa giá, quy hoạch, tên dự án hay số liệu thị trường. Thiếu dữ liệu thì nói rõ là thiếu.
- Khi nêu giá, ghi rõ dựa trên tin rao nào (mã tin, khoảng cách, giá sau điều chỉnh).
- Giá trong hồ sơ là VND; viết theo kiểu Việt Nam (ví dụ 85,3 tr/m², 4,2 tỷ).

Trả lời bằng tiếng Việt, ngắn gọn, theo cấu trúc:
## Tóm tắt giá
Đơn giá và tổng giá ước tính, khoảng giá, phương pháp, độ tin cậy.
## Điểm mạnh
## Rủi ro
Xét lần lượt: pháp lý; quy hoạch (lộ giới, đất không phải đất ở); thanh khoản; chênh lệch giữa giá rao và giá giao dịch; độ tin cậy của dữ liệu (số tin, độ phân tán, ranh thửa tham khảo từ OpenStreetMap).
## Khuyến nghị
Một trong: mua, đàm phán, hoặc tránh; kèm khoảng giá nên đàm phán (tổng và theo m²) và các việc cần kiểm tra trước khi đặt cọc.

Với câu hỏi tiếp theo, trả lời thẳng vào câu hỏi, không cần lặp lại toàn bộ cấu trúc.

Luôn kết thúc bằng câu: "Đây là phân tích tham khảo, không phải chứng thư thẩm định giá."`;

const ACCESS_VALUES: Access[] = ['mat-tien', 'hem-lon', 'hem-vua', 'hem-nho', 'unknown'];
const LEGAL_VALUES: LegalStatus[] = ['so-rieng', 'so-chung', 'cho-so', 'giay-tay', 'unknown'];

/** Tool order is fixed: changing it would invalidate the cached prefix. */
export const ADVISOR_TOOLS: BetaTool[] = [
  {
    name: 'get_dossier',
    description:
      'Trả về hồ sơ định giá JSON (lược đồ tinymap.valuation/v1) của thửa đất đang xem: thông tin thửa, tin rao lân cận, kết quả định giá, các điều chỉnh và giả định. Gọi trước khi trả lời câu hỏi đầu tiên.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'revalue',
    description:
      'Định giá lại thửa đất với các giả định khác (phương pháp so sánh). roadWideningShare là tỉ lệ diện tích dính lộ giới, từ 0 đến 1. askDiscount là mức trừ từ giá rao về giá giao dịch, từ 0 đến 0.5 (mặc định 0.08). Trả về đơn giá, tổng giá, khoảng giá, độ tin cậy và các tin rao đã dùng.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        access: { type: 'string', enum: ACCESS_VALUES, description: 'mat-tien = mặt tiền đường; hem-lon ≥ 5 m; hem-vua 3–5 m; hem-nho < 3 m' },
        corner: { type: 'boolean', description: 'Lô góc / hai mặt tiền' },
        legal: { type: 'string', enum: LEGAL_VALUES, description: 'so-rieng = sổ riêng; so-chung = sổ chung; cho-so = chờ sổ; giay-tay = giấy tay/vi bằng' },
        roadWideningShare: { type: 'number' },
        askDiscount: { type: 'number' },
      },
      required: ['access', 'corner', 'legal', 'roadWideningShare', 'askDiscount'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_comparables',
    description:
      'Lấy lại tin rao bán đất trong bán kính radiusM mét quanh thửa đất (100 đến 5000), kèm thống kê giá/m² và kết quả định giá với giả định hiện tại.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { radiusM: { type: 'number' } },
      required: ['radiusM'],
      additionalProperties: false,
    },
  },
];

// ---- Injectable client surface (the subset of the SDK we use) ----

export interface AdvisorStream {
  on(event: 'text', listener: (delta: string) => void): unknown;
  finalMessage(): Promise<BetaMessage>;
}

export interface AdvisorClient {
  beta: { messages: { stream(body: BetaMessageStreamParams, options?: { signal?: AbortSignal }): AdvisorStream } };
}

export interface AdvisorContext {
  dossier: ValuationDossier;
  parcel: Parcel;
  /** All listings loaded for the region; get_comparables and revalue filter them by radius. */
  listings: Listing[];
  assumptions: Assumptions;
  /** For tests; otherwise built from the stored key on first use. */
  client?: AdvisorClient;
}

export type AdvisorErrorKind = 'no-key' | 'auth' | 'rate-limit' | 'offline' | 'aborted' | 'api';

export class AdvisorError extends Error {
  constructor(
    readonly kind: AdvisorErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'AdvisorError';
  }
}

export const REFUSAL_TEXT =
  'Mô hình từ chối trả lời câu hỏi này (bộ lọc an toàn). Hãy diễn đạt lại câu hỏi, tập trung vào giá, pháp lý và rủi ro của thửa đất.';
export const TRUNCATED_TEXT = '\n\n_(Câu trả lời bị cắt vì quá dài. Hãy hỏi ngắn hơn hoặc hỏi tiếp phần còn lại.)_';
export const ITERATION_CAP_TEXT = '\n\n_(Đã dừng sau 6 lượt gọi công cụ. Hãy hỏi cụ thể hơn.)_';

type SdkModule = typeof import('@anthropic-ai/sdk');

async function loadSdk(): Promise<SdkModule> {
  return import('@anthropic-ai/sdk');
}

/** Maps SDK errors to Vietnamese messages; never includes the key or request body. */
export async function toAdvisorError(err: unknown): Promise<AdvisorError> {
  if (err instanceof AdvisorError) return err;
  let sdk: SdkModule | null = null;
  try {
    sdk = await loadSdk();
  } catch {
    /* fall through to the generic message */
  }
  if (sdk) {
    if (err instanceof sdk.APIUserAbortError) return new AdvisorError('aborted', 'Đã dừng.');
    if (err instanceof sdk.AuthenticationError) return new AdvisorError('auth', 'Key Anthropic không hợp lệ. Kiểm tra lại key trong phần cài đặt.');
    if (err instanceof sdk.PermissionDeniedError) return new AdvisorError('auth', 'Key Anthropic không có quyền dùng mô hình này.');
    if (err instanceof sdk.RateLimitError) return new AdvisorError('rate-limit', 'Đã vượt giới hạn gọi API Anthropic. Đợi một lát rồi thử lại.');
    // APIConnectionTimeoutError extends APIConnectionError.
    if (err instanceof sdk.APIConnectionError) return new AdvisorError('offline', 'Không kết nối được tới Anthropic. Kiểm tra mạng rồi thử lại.');
    if (err instanceof sdk.APIError) return new AdvisorError('api', `Lỗi từ Anthropic${err.status ? ` (${err.status})` : ''}. Thử lại sau.`);
  }
  if (err instanceof DOMException && err.name === 'AbortError') return new AdvisorError('aborted', 'Đã dừng.');
  return new AdvisorError('api', 'Không gọi được cố vấn AI. Thử lại sau.');
}

/**
 * After a mid-output server-side fallback, blocks from the declined model that precede the last
 * `fallback` marker must not be echoed back: thinking, redacted thinking, tool calls (the docs'
 * "Echoing fallback turns back" rule). Without a fallback block the content is returned as is.
 */
export function echoableContent(content: BetaContentBlock[]): BetaContentBlock[] {
  let last = -1;
  content.forEach((b, i) => {
    if (b.type === 'fallback') last = i;
  });
  if (last < 0) return content;
  const drop = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use', 'mcp_tool_use']);
  return content.filter((b, i) => i >= last || !drop.has(b.type));
}

// ---- Tools ----

type ToolOutput = { content: string; isError?: boolean };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function compactValuation(v: Valuation) {
  const r = (x: number) => Math.round(x);
  return {
    method: v.method,
    pricePerM2: r(v.pricePerM2),
    total: r(v.total),
    low: r(v.low),
    high: r(v.high),
    confidence: v.confidence,
    used: v.used.map((u) => ({ id: u.id, distance: r(u.distance), raw: r(u.raw), adjusted: r(u.adjusted), weight: Math.round(u.weight * 1000) / 1000 })),
    rejected: v.rejected,
    notes: v.notes,
  };
}

export function runTool(ctx: AdvisorContext, name: string, input: unknown): ToolOutput {
  const center = ringCenter(ctx.parcel.ring);
  const compsWithin = (radiusM: number) => nearby(ctx.listings, center[0], center[1], radiusM);
  const err = (msg: string): ToolOutput => ({ content: msg, isError: true });
  if (!isObj(input)) return err('Đầu vào phải là một object JSON.');
  switch (name) {
    case 'get_dossier':
      return { content: JSON.stringify(ctx.dossier) };
    case 'revalue': {
      const { access, corner, legal, roadWideningShare, askDiscount } = input;
      if (typeof access !== 'string' || !ACCESS_VALUES.includes(access as Access)) return err(`access phải là một trong ${ACCESS_VALUES.join(', ')}.`);
      if (typeof corner !== 'boolean') return err('corner phải là true hoặc false.');
      if (typeof legal !== 'string' || !LEGAL_VALUES.includes(legal as LegalStatus)) return err(`legal phải là một trong ${LEGAL_VALUES.join(', ')}.`);
      if (typeof roadWideningShare !== 'number' || !(roadWideningShare >= 0 && roadWideningShare <= 1)) return err('roadWideningShare phải trong khoảng 0 đến 1.');
      if (typeof askDiscount !== 'number' || !(askDiscount >= 0 && askDiscount <= 0.5)) return err('askDiscount phải trong khoảng 0 đến 0.5.');
      const a: Assumptions = { ...ctx.assumptions, access: access as Access, corner, legal: legal as LegalStatus, roadWideningShare, askDiscount };
      const v = valueParcel(ctx.parcel, compsWithin(ctx.dossier.market.radiusM), a);
      const base = ctx.dossier.valuation.pricePerM2;
      return {
        content: JSON.stringify({
          assumptions: a,
          valuation: compactValuation(v),
          changeVsDossier: base > 0 && v.pricePerM2 > 0 ? Math.round((v.pricePerM2 / base - 1) * 1000) / 1000 : null,
        }),
      };
    }
    case 'get_comparables': {
      const { radiusM } = input;
      if (typeof radiusM !== 'number' || !(radiusM >= 100 && radiusM <= 5000)) return err('radiusM phải trong khoảng 100 đến 5000 mét.');
      const comps = compsWithin(radiusM);
      const v = valueParcel(ctx.parcel, comps, ctx.assumptions);
      return {
        content: JSON.stringify({
          radiusM,
          stats: marketStats(comps),
          // Nearest 30 only: enough to reason about, small enough for the context window.
          comparables: comps.slice(0, 30).map((c) => ({
            id: c.id,
            distance: Math.round(c.distance),
            pricePerM2: c.pricePerM2,
            size: c.size,
            legal: c.legal,
            access: c.access,
            corner: c.corner,
            time: new Date(c.time).toISOString(),
          })),
          valuation: compactValuation(v),
        }),
      };
    }
    default:
      return err(`Không có công cụ ${name}.`);
  }
}

// ---- Conversation ----

export class Advisor {
  /** Full conversation, sent on every request (the API is stateless). */
  readonly history: BetaMessageParam[] = [];
  private client: AdvisorClient | null;

  constructor(private readonly ctx: AdvisorContext) {
    this.client = ctx.client ?? null;
  }

  /** The exact request body for the current history (exported for tests and debugging). */
  request(): BetaMessageStreamParams {
    return {
      model: ADVISOR_MODEL,
      max_tokens: ADVISOR_MAX_TOKENS,
      // Always on for this model; effort is the real control, set explicitly (default is medium).
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      // On a policy decline the API re-runs the request on Anthropic's recommended fallback model.
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      // Automatic caching of the stable prefix (system + tools + earlier turns).
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: SYSTEM_PROMPT }],
      tools: ADVISOR_TOOLS,
      messages: [...this.history],
    };
  }

  private async getClient(): Promise<AdvisorClient> {
    if (this.client) return this.client;
    const key = anthropicKey();
    if (!key) throw new AdvisorError('no-key', 'Chưa có key Anthropic. Nhập key để dùng cố vấn AI.');
    const { default: Anthropic } = await loadSdk();
    // The key belongs to the user and stays in their browser, hence dangerouslyAllowBrowser.
    this.client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true }) as unknown as AdvisorClient;
    return this.client;
  }

  /**
   * Asks one question; streams answer text through `onText` and resolves with the whole answer.
   * On error the history is rolled back so the conversation stays valid for the next question.
   */
  async ask(question: string, onText: (delta: string) => void, signal?: AbortSignal): Promise<string> {
    const mark = this.history.length;
    let answer = '';
    const emit = (t: string) => {
      answer += t;
      onText(t);
    };
    try {
      const client = await this.getClient();
      this.history.push({ role: 'user', content: question });
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const stream = client.beta.messages.stream(this.request(), { signal });
        let first = true;
        stream.on('text', (delta) => {
          // Separate text from successive turns of the loop.
          if (first && answer && !answer.endsWith('\n')) emit('\n\n');
          first = false;
          emit(delta);
        });
        const msg = await stream.finalMessage();
        const content = echoableContent(msg.content);

        if (msg.stop_reason === 'refusal') {
          // The whole fallback chain declined. Keep the partial only if there is something to echo.
          if (content.length) this.history.push({ role: 'assistant', content });
          emit((answer ? '\n\n' : '') + REFUSAL_TEXT);
          return answer;
        }

        const toolUses = content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
        if (msg.stop_reason === 'max_tokens') {
          // A tool call cut off at max_tokens may parse as a valid partial input: never run it,
          // and drop the turn so history has no tool_use without a tool_result.
          if (!toolUses.length && content.length) this.history.push({ role: 'assistant', content });
          emit(TRUNCATED_TEXT);
          return answer;
        }

        this.history.push({ role: 'assistant', content });
        if (msg.stop_reason === 'pause_turn') continue;
        if (msg.stop_reason !== 'tool_use' || !toolUses.length) return answer;

        const results: BetaToolResultBlockParam[] = toolUses.map((t) => {
          const out = runTool(this.ctx, t.name, t.input);
          return { type: 'tool_result', tool_use_id: t.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
        });
        this.history.push({ role: 'user', content: results });
      }
      emit(ITERATION_CAP_TEXT);
      return answer;
    } catch (e) {
      this.history.length = mark;
      throw await toAdvisorError(e);
    }
  }

  /** Starts a fresh conversation (e.g. after the user switches parcel). */
  reset() {
    this.history.length = 0;
  }
}
