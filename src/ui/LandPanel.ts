import type { BBox, LngLat } from '../data/types';
import { Advisor, AdvisorError, anthropicKey, setAnthropicKey } from '../land/advisor';
import { buildDossier, dossierToMarkdown, type ValuationDossier } from '../land/dossier';
import { parseGeoJson, parseKml, parseVn2000Table, type ImportedShape } from '../land/importers';
import { GROUP_COLOR, GROUP_LABEL, LAND_TYPES, landColor, landGroup, landType } from '../land/landTypes';
import { filterOutliers, loadLive, loadMarket, marketProxy, marketStats, nearby, type NearbyListing, parseListingsCsv, setMarketProxy } from '../land/market';
import { loadOsmParcels } from '../land/osmParcels';
import { makeParcel } from '../land/parcels';
import type { Access, LandGroup, LegalStatus, Listing, MarketStats, Parcel, ParcelShape, Street } from '../land/types';
import { type Assumptions, defaultAssumptions, DISCLAIMER, ringCenter, type Valuation, valueParcel } from '../land/valuation';
import { PROVINCE_MERIDIANS } from '../land/vn2000';
import type { MapView } from './MapView';

/**
 * Side panel for land parcels (#37), market asking prices (#38), valuation and the AI advisor
 * (#39) on the 2D map. All data logic lives in src/land/; this file only wires it to the DOM
 * and to the parcel / market layers of MapView.
 */

type Tab = 'list' | 'detail' | 'market' | 'value';

const SHAPE_LABEL: Record<ParcelShape, string> = { vuong: 'vuông vức', 'no-hau': 'nở hậu', 'top-hau': 'tóp hậu', meo: 'méo' };
const LEGAL_LABEL: Record<LegalStatus, string> = { 'so-rieng': 'Sổ riêng', 'so-chung': 'Sổ chung', 'cho-so': 'Chờ sổ', 'giay-tay': 'Giấy tay', unknown: 'Chưa rõ' };
const ACCESS_LABEL: Record<Exclude<Access, 'unknown'>, string> = { 'mat-tien': 'Mặt tiền', 'hem-lon': 'Hẻm ≥ 5 m', 'hem-vua': 'Hẻm 3–5 m', 'hem-nho': 'Hẻm < 3 m' };
const SOURCE_LABEL: Record<Parcel['source'], string> = { osm: 'OpenStreetMap (tham khảo)', vn2000: 'Toạ độ VN-2000 (sổ đỏ)', import: 'Tệp nhập (GeoJSON/KML)' };
const CONF_LABEL: Record<Valuation['confidence'], string> = { high: 'cao', medium: 'trung bình', low: 'thấp' };
const METHOD_LABEL: Record<Valuation['method'], string> = { 'so-sanh': 'So sánh trực tiếp', 'trung-vi-khu-vuc': 'Trung vị khu vực', 'khong-du-lieu': 'Không đủ dữ liệu' };
const RADII = [500, 1000, 2000, 5000];
/** Wider ring used as the area median when nothing lies inside the chosen radius (#39). */
const AREA_RADIUS = 5000;
const DEFAULT_QUESTION = 'Đánh giá thửa đất này cho nhà đầu tư.';

const nf = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d, minimumFractionDigits: d });
const trM2 = (v: number) => (Number.isFinite(v) ? `${nf(v / 1e6, 1)} tr/m²` : '–');
const money = (v: number) => (v >= 1e9 ? `${nf(v / 1e9, 2)} tỷ` : `${nf(v / 1e6, 0)} triệu`);
const dist = (m: number) => (m < 1000 ? `${nf(m)} m` : `${nf(m / 1000, 1)} km`);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain text with a little Markdown (headings, bullets, **bold**), HTML-escaped first (#39). */
export function miniMarkdown(text: string): string {
  return esc(text)
    .split('\n')
    .map((line) => {
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) return `<b class="md-h">${h[1]}</b>`;
      const li = /^\s*[-*]\s+(.*)$/.exec(line);
      const body = li ? `• ${li[1]}` : line;
      return body.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)_(\S.*?\S|\S)_(?=\s|$|[.,;:])/g, '$1<i>$2</i>');
    })
    .join('<br>');
}

interface MarketData {
  listings: Listing[];
  generated: string;
  stale: boolean;
  source: string;
  error?: string;
}

export interface LandPanelOptions {
  /** Called when the panel opens, so the host can close panels sharing the same spot. */
  onOpen?: () => void;
}

export class LandPanel {
  readonly el: HTMLElement;
  private readonly btn: HTMLButtonElement;
  private tab: Tab = 'list';
  private osm: Parcel[] = [];
  private streets: Street[] = [];
  private imported: Parcel[] = [];
  private selected: Parcel | null = null;
  private loadAbort: AbortController | null = null;
  private loadedBBox: string | null = null;
  private bboxTimer = 0;
  private listStatus = '';

  // Market (#38)
  private radius = 1000;
  private snapshot: Promise<MarketData> | null = null;
  private userListings: Listing[] = [];
  private market: { data: MarketData; near: NearbyListing[]; kept: NearbyListing[]; stats: MarketStats; areaMedian?: number; key: string } | null = null;
  private marketSeq = 0;

  // Valuation and advisor (#39)
  private assumptions: Assumptions | null = null;
  private advisor: Advisor | null = null;
  private advisorKey = '';
  private askAbort: AbortController | null = null;

  constructor(
    private readonly mapView: MapView,
    button: HTMLButtonElement,
    private readonly opts: LandPanelOptions = {},
  ) {
    this.btn = button;
    this.el = document.createElement('div');
    this.el.id = 'land';
    this.el.className = 'offline land card';
    this.el.hidden = true;
    this.el.innerHTML = TEMPLATE;
    mapView.map.getContainer().parentElement!.appendChild(this.el);
    this.fillSelects();
    this.bind();
    mapView.onParcelClick = (id) => {
      if (this.el.hidden) return;
      const p = this.find(id);
      if (p) this.select(p, true);
    };
  }

  get isOpen() {
    return !this.el.hidden;
  }

  toggle() {
    if (this.el.hidden) this.open();
    else this.close();
  }

  open() {
    this.opts.onOpen?.();
    this.el.hidden = false;
    this.btn.classList.add('on');
    this.ensureParcels();
    this.renderAll();
  }

  close() {
    this.el.hidden = true;
    this.btn.classList.remove('on');
    this.loadAbort?.abort();
    this.askAbort?.abort();
    this.mapView.setParcels(null);
    this.mapView.setMarket(null);
  }

  /** The selection rectangle changed: reload reference parcels (debounced) while open. */
  bboxChanged(_b: BBox | null) {
    if (this.el.hidden) return;
    clearTimeout(this.bboxTimer);
    this.bboxTimer = window.setTimeout(() => this.ensureParcels(), 400);
  }

  // ---------- DOM ----------

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.el.querySelector(sel) as T;
  }

  private fillSelects() {
    const prov = this.q<HTMLSelectElement>('#land-prov');
    const names = Object.keys(PROVINCE_MERIDIANS).sort((a, b) => a.localeCompare(b, 'vi'));
    prov.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)} (${nf(PROVINCE_MERIDIANS[n], 2)}°)</option>`).join('');
    prov.value = 'TP. Hồ Chí Minh';
    const code = this.q<HTMLSelectElement>('#land-code');
    const groups: LandGroup[] = ['PNN', 'NNP', 'CSD'];
    const depth = (c: string): number => {
      const p = landType(c)?.parent;
      return p ? 1 + depth(p) : 0;
    };
    code.innerHTML =
      '<option value="">Theo tệp / chưa rõ</option>' +
      groups
        .map(
          (g) =>
            `<optgroup label="${esc(GROUP_LABEL[g])}">${LAND_TYPES.filter((t) => t.group === g)
              .map((t) => `<option value="${t.code}">${'  '.repeat(depth(t.code))}${t.code} · ${esc(t.name)}</option>`)
              .join('')}</optgroup>`,
        )
        .join('');
    this.q<HTMLSelectElement>('#land-radius').innerHTML = RADII.map((r) => `<option value="${r}"${r === this.radius ? ' selected' : ''}>${dist(r)}</option>`).join('');
  }

  private bind() {
    this.q('#land-close').addEventListener('click', () => this.close());
    this.el.querySelectorAll<HTMLButtonElement>('.land-tabs button').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.tab as Tab)));
    this.q('#land-import-toggle').addEventListener('click', () => {
      const f = this.q('#land-import');
      f.hidden = !f.hidden;
    });
    this.q('#land-import-go').addEventListener('click', () => void this.doImport());
    this.q('#land-radius').addEventListener('change', (e) => {
      this.radius = Number((e.target as HTMLSelectElement).value);
      void this.refreshMarket();
    });
    this.q('#land-csv').addEventListener('change', (e) => void this.importCsv(e.target as HTMLInputElement));
    this.q('#land-csv-btn').addEventListener('click', () => this.q<HTMLInputElement>('#land-csv').click());
    this.q('#land-proxy').addEventListener('click', () => {
      const cur = marketProxy();
      const v = prompt(
        'URL proxy CORS tới Chợ Tốt (xem docs/market-proxy.md), ví dụ https://my-proxy.example.workers.dev/\nĐể trống để xoá proxy và dùng ảnh chụp hằng ngày.',
        cur ?? '',
      );
      if (v === null) return;
      setMarketProxy(v.trim() || null);
      this.market = null;
      void this.refreshMarket();
    });
    // Assumption controls: recalculated live.
    for (const id of ['#va-access', '#va-corner', '#va-legal', '#va-road']) this.q(id).addEventListener('input', () => this.readAssumptions());
    this.q('#va-json').addEventListener('click', () => this.downloadDossier());
    this.q('#va-md').addEventListener('click', () => void this.copyMarkdown());
    this.q('#ai-ask').addEventListener('click', (e) => void this.ask(DEFAULT_QUESTION, (e as MouseEvent).shiftKey));
    this.q('#ai-send').addEventListener('click', () => this.sendFollowUp());
    this.q('#ai-input').addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && this.sendFollowUp());
    this.q('#ai-cancel').addEventListener('click', () => this.askAbort?.abort());
  }

  private setTab(t: Tab) {
    this.tab = t;
    this.el.querySelectorAll<HTMLButtonElement>('.land-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    this.el.querySelectorAll<HTMLElement>('.land-sec').forEach((s) => (s.hidden = s.dataset.sec !== t));
    if (t === 'market' || t === 'value') void this.refreshMarket();
    else this.mapView.setMarket(null);
    this.renderAll();
  }

  private renderAll() {
    this.renderList();
    this.renderDetail();
    if (this.tab === 'value') this.renderValuation();
  }

  // ---------- Parcels (#37) ----------

  private all(): Parcel[] {
    return [...this.imported, ...this.osm];
  }

  private find(id: string): Parcel | undefined {
    return this.all().find((p) => p.id === id);
  }

  private async ensureParcels() {
    const b = this.mapView.bbox;
    const key = b ? [b.west, b.south, b.east, b.north].map((v) => v.toFixed(5)).join(',') : '';
    if (key === this.loadedBBox) return void this.pushParcels();
    this.loadAbort?.abort();
    this.loadedBBox = key;
    if (!b) {
      this.osm = [];
      this.listStatus = 'Chưa chọn vùng: bấm ▭ hoặc ◎ để chọn một khu.';
      if (this.selected?.source === 'osm') this.select(null);
      return void this.renderAll();
    }
    const ac = (this.loadAbort = new AbortController());
    this.listStatus = 'Đang tải lớp sử dụng đất OpenStreetMap…';
    this.renderList();
    try {
      const t0 = performance.now();
      const r = await loadOsmParcels(b, ac.signal);
      if (ac.signal.aborted) return;
      this.osm = r.parcels;
      this.streets = r.streets;
      this.listStatus = `${nf(r.parcels.length)} vùng trong khu chọn · ${nf((performance.now() - t0) / 1000, 1)} s`;
      if (this.selected?.source === 'osm' && !this.find(this.selected.id)) this.select(null);
    } catch (e) {
      if (ac.signal.aborted) return;
      this.osm = [];
      this.loadedBBox = null;
      this.listStatus = `Không tải được lớp sử dụng đất: ${(e as Error).message}`;
    }
    this.renderAll();
  }

  private pushParcels() {
    if (this.el.hidden) return;
    const sel = this.selected?.id;
    const features = this.all().map((p) => ({
      type: 'Feature' as const,
      properties: { id: p.id, color: landColor(p.landCode), sel: p.id === sel, area: p.metrics.area },
      geometry: { type: 'Polygon' as const, coordinates: [[...p.ring, p.ring[0]]] },
    }));
    this.mapView.setParcels({ type: 'FeatureCollection', features }, sel);
  }

  private renderList() {
    const list = this.all().sort((a, b) => b.metrics.area - a.metrics.area);
    this.q('#land-status').textContent = this.listStatus + (this.imported.length ? ` · ${nf(this.imported.length)} thửa đã nhập` : '');
    // Legend by group, with counts.
    const counts = new Map<LandGroup | '?', number>();
    for (const p of list) {
      const g = landGroup(p.landCode) ?? '?';
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    this.q('#land-legend').innerHTML = (['PNN', 'NNP', 'CSD'] as LandGroup[])
      .filter((g) => counts.get(g))
      .map((g) => `<span><i style="background:${GROUP_COLOR[g]}"></i>${esc(GROUP_LABEL[g])} (${counts.get(g)})</span>`)
      .join('');
    const ul = this.q('#land-list');
    ul.innerHTML = '';
    for (const p of list) {
      const m = p.metrics;
      const li = document.createElement('li');
      li.dataset.id = p.id;
      li.classList.toggle('on', p.id === this.selected?.id);
      const name = landType(p.landCode)?.name ?? p.landCode;
      const dims = `${m.frontage != null ? nf(m.frontage, 1) : '–'} × ${nf(m.depth, 1)} m`;
      li.innerHTML =
        `<span class="chip" style="background:${landColor(p.landCode)}">${esc(p.landCode)}</span>` +
        `<span class="ll-main"><span>${esc(name)}${p.landCodeGuessed ? ' <small>(gợi ý từ OSM)</small>' : ''}${p.source !== 'osm' ? ' <small class="accent">· đã nhập</small>' : ''}</span>` +
        `<small>${p.name ? `${esc(p.name)} · ` : ''}${dims} · ${SHAPE_LABEL[m.shape]}</small></span>` +
        `<b>${nf(m.area)} m²</b>`;
      li.addEventListener('click', () => this.select(p, false));
      ul.appendChild(li);
    }
    this.pushParcels();
  }

  private select(p: Parcel | null, fromMap = false) {
    const changed = p?.id !== this.selected?.id;
    this.selected = p;
    if (changed) {
      this.assumptions = p ? defaultAssumptions(p) : null;
      this.syncAssumptionControls();
    }
    this.el.querySelectorAll<HTMLElement>('#land-list li').forEach((li) => li.classList.toggle('on', li.dataset.id === p?.id));
    if (fromMap) this.el.querySelector<HTMLElement>('#land-list li.on')?.scrollIntoView({ block: 'nearest' });
    this.pushParcels();
    if (p && this.tab === 'list') this.setTab('detail');
    else {
      this.renderDetail();
      if (this.tab === 'market' || this.tab === 'value') void this.refreshMarket();
    }
  }

  private renderDetail() {
    const box = this.q('#land-detail');
    const p = this.selected;
    if (!p) {
      box.innerHTML = '<div class="muted small">Chọn một thửa trong danh sách hoặc bấm lên bản đồ.</div>';
      return;
    }
    const m = p.metrics;
    const t = landType(p.landCode);
    const g = landGroup(p.landCode);
    const rows: [string, string][] = [
      ['Loại đất', `<span class="chip" style="background:${landColor(p.landCode)}">${esc(p.landCode)}</span> ${esc(t?.name ?? 'Không rõ mã')}${p.landCodeGuessed ? ' <small class="muted">(gợi ý từ OSM)</small>' : ''}`],
      ['Nhóm', g ? esc(GROUP_LABEL[g]) : '–'],
      ['Diện tích', `${nf(m.area, 1)} m²`],
      ['Chu vi', `${nf(m.perimeter, 1)} m`],
      ['Mặt tiền', m.frontage != null ? `${nf(m.frontage, 2)} m` : 'không xác định'],
      ['Chiều sâu', `${nf(m.depth, 2)} m`],
      ['Hình dáng', SHAPE_LABEL[m.shape]],
      ['Đường gần nhất', m.streetDistance != null ? `${esc(m.streetName ?? 'đường không tên')} · ${nf(m.streetDistance, 1)} m` : 'không có đường trong 40 m'],
      ['Nguồn', esc(SOURCE_LABEL[p.source]) + (p.osmClass ? ` <small class="muted">(${esc(p.osmClass)})</small>` : '')],
      ['Số tờ / số thửa', p.soTo || p.soThua ? `${esc(p.soTo ?? '–')} / ${esc(p.soThua ?? '–')}` : '–'],
    ];
    if (p.name) rows.splice(1, 0, ['Tên', esc(p.name)]);
    const edges = m.edges.map((e, i) => `<tr${e.front ? ' class="front"' : ''}><td>Cạnh ${i + 1}</td><td>${nf(e.length, 2)} m</td><td>${e.front ? 'mặt tiền' : ''}</td></tr>`).join('');
    box.innerHTML =
      `<dl class="land-dl">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` +
      `<table class="land-table"><tbody>${edges}</tbody></table>` +
      `<div class="off-row"><button class="ghost small" data-go="market">Giá thị trường →</button><button class="ghost small" data-go="value">Định giá →</button></div>`;
    box.querySelectorAll<HTMLButtonElement>('[data-go]').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.go as Tab)));
  }

  private async doImport() {
    const status = this.q('#land-import-status');
    status.textContent = '';
    const prov = this.q<HTMLSelectElement>('#land-prov').value;
    const cm = PROVINCE_MERIDIANS[prov];
    const text = this.q<HTMLTextAreaElement>('#land-vn2000').value.trim();
    const file = this.q<HTMLInputElement>('#land-file').files?.[0];
    const soTo = this.q<HTMLInputElement>('#land-soto').value.trim();
    const soThua = this.q<HTMLInputElement>('#land-sothua').value.trim();
    const code = this.q<HTMLSelectElement>('#land-code').value;
    try {
      let shapes: ImportedShape[];
      let source: Parcel['source'];
      if (file) {
        const body = await file.text();
        shapes = /\.kml$/i.test(file.name) ? parseKml(body, cm) : parseGeoJson(body, cm);
        source = 'import';
      } else if (text) {
        shapes = [{ ring: parseVn2000Table(text, cm).ring, properties: {} }];
        source = 'vn2000';
      } else throw new Error('Dán bảng toạ độ VN-2000 hoặc chọn một tệp.');
      if (!shapes.length) throw new Error('Không tìm thấy đa giác nào trong tệp.');
      const added = shapes.map((s, i) =>
        makeParcel(
          {
            id: `${source}/${Date.now().toString(36)}-${i}`,
            source,
            ring: s.ring,
            landCode: code || s.landCode || 'ODT',
            landCodeGuessed: !code && !s.landCode,
            soTo: soTo || s.soTo,
            soThua: shapes.length === 1 ? soThua || s.soThua : s.soThua,
            name: s.name,
          },
          this.streets,
        ),
      );
      this.imported.push(...added);
      status.textContent = `Đã thêm ${added.length} thửa.`;
      this.fitTo(added);
      this.select(added[0], false);
      this.renderList();
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  }

  private fitTo(ps: Parcel[]) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of ps)
      for (const [x, y] of p.ring) (w = Math.min(w, x)), (e = Math.max(e, x)), (s = Math.min(s, y)), (n = Math.max(n, y));
    if (Number.isFinite(w)) this.mapView.map.fitBounds([[w, s], [e, n]], { padding: 120, maxZoom: 19, duration: 800 });
  }

  // ---------- Market (#38) ----------

  private center(): LngLat | null {
    if (this.selected) return ringCenter(this.selected.ring);
    const b = this.mapView.bbox;
    return b ? [(b.west + b.east) / 2, (b.south + b.north) / 2] : null;
  }

  private loadSnapshot(): Promise<MarketData> {
    return (this.snapshot ??= loadMarket('all')
      .then((s) => ({ listings: s.listings, generated: s.generated, stale: s.stale, source: 'Chợ Tốt (ảnh chụp hằng ngày)' }))
      .catch((e) => {
        this.snapshot = null; // retry next time
        return { listings: [], generated: '', stale: false, source: 'Chợ Tốt', error: (e as Error).message };
      }));
  }

  private async refreshMarket() {
    const c = this.center();
    const box = this.q('#land-market');
    if (!c) {
      box.innerHTML = '<div class="muted small">Chọn vùng hoặc một thửa để xem giá quanh đó.</div>';
      return;
    }
    const key = `${c[0].toFixed(6)},${c[1].toFixed(6)}|${this.radius}|${this.userListings.length}|${marketProxy() ?? ''}`;
    if (this.market?.key === key) return void this.renderMarket();
    const seq = ++this.marketSeq;
    box.innerHTML = '<div class="muted small">Đang tải giá rao bán…</div>';
    let data: MarketData;
    if (marketProxy()) {
      try {
        const live = await loadLive(c, Math.max(this.radius, AREA_RADIUS));
        data = { listings: live, generated: new Date().toISOString(), stale: false, source: 'Chợ Tốt (trực tiếp qua proxy)' };
      } catch (e) {
        data = { ...(await this.loadSnapshot()) };
        data.error = `Proxy lỗi (${(e as Error).message}); dùng ảnh chụp hằng ngày.`;
      }
    } else data = await this.loadSnapshot();
    if (seq !== this.marketSeq) return;
    const listings = [...data.listings, ...this.userListings];
    const near = nearby(listings, c[0], c[1], this.radius);
    const { kept } = filterOutliers(near);
    const stats = marketStats(near);
    // Area median for the valuation's shrinkage: the radius median, else a 5 km ring (#39).
    const wide = Number.isFinite(stats.median) ? stats.median : marketStats(nearby(listings, c[0], c[1], AREA_RADIUS)).median;
    this.market = { data: { ...data, listings }, near, kept, stats, areaMedian: Number.isFinite(wide) ? wide : undefined, key };
    this.renderMarket();
    if (this.tab === 'value') this.renderValuation();
  }

  private renderMarket() {
    const mk = this.market;
    const box = this.q('#land-market');
    if (!mk) return;
    const { stats, kept, data } = mk;
    const when = data.generated ? new Date(data.generated).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' }) : '–';
    const where = this.selected ? 'quanh thửa đã chọn' : 'quanh tâm vùng chọn';
    const top = [...kept].sort((a, b) => a.distance - b.distance).slice(0, 20);
    box.innerHTML =
      (data.error ? `<div class="error small">${esc(data.error)}</div>` : '') +
      `<div class="land-stats"><div><b>${nf(stats.count)}</b><small>tin ${where}${stats.outliers ? `, loại ${stats.outliers} bất thường` : ''}</small></div>` +
      `<div><b>${trM2(stats.median)}</b><small>trung vị</small></div>` +
      `<div><b>${Number.isFinite(stats.p25) ? `${nf(stats.p25 / 1e6, 1)}–${nf(stats.p75 / 1e6, 1)}` : '–'}</b><small>P25–P75 tr/m²</small></div></div>` +
      `<div class="muted small">Cập nhật: ${when}${data.stale ? ' (bản cũ, đang offline)' : ''} · ${esc(data.source)}${this.userListings.length ? ` · ${this.userListings.length} tin tự nhập` : ''}</div>` +
      (top.length
        ? `<ul class="off-list land-comps">${top
            .map(
              (l) =>
                `<li><span class="ll-main"><span><b>${money(l.price)}</b> · ${nf(l.size, 1)} m² · ${trM2(l.pricePerM2)}</span>` +
                `<small>${dist(l.distance)} · ${LEGAL_LABEL[l.legal]} · ${new Date(l.time).toLocaleDateString('vi-VN')}${l.source === 'user' ? ' · tự nhập' : ''}${l.street ? ` · ${esc(l.street)}` : ''}</small></span>` +
                (l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">Xem tin</a>` : '') +
                `</li>`,
            )
            .join('')}</ul>`
        : `<div class="muted small">Không có tin rao nào trong bán kính ${dist(this.radius)}. Thử bán kính lớn hơn hoặc nhập CSV.</div>`);
    if (this.tab === 'market' || this.tab === 'value')
      this.mapView.setMarket({
        type: 'FeatureCollection',
        features: kept.map((l) => ({ type: 'Feature', properties: { id: l.id, ppm2: l.pricePerM2 }, geometry: { type: 'Point', coordinates: [l.lon, l.lat] } })),
      });
  }

  private async importCsv(input: HTMLInputElement) {
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    const rows = parseListingsCsv(await f.text());
    if (!rows.length) return alert('Không đọc được tin nào. CSV cần các cột lat, lon, diện tích và giá (hoặc giá/m²).');
    // Unique ids across several imports.
    const tag = Date.now().toString(36);
    this.userListings.push(...rows.map((r) => ({ ...r, id: `${r.id}-${tag}` })));
    await this.refreshMarket();
  }

  // ---------- Valuation (#39) ----------

  private syncAssumptionControls() {
    const a = this.assumptions;
    if (!a) return;
    this.q<HTMLSelectElement>('#va-access').value = a.access === 'unknown' ? 'hem-vua' : a.access;
    this.q<HTMLInputElement>('#va-corner').checked = a.corner;
    this.q<HTMLSelectElement>('#va-legal').value = a.legal;
    this.q<HTMLInputElement>('#va-road').value = String(Math.round(a.roadWideningShare * 100));
  }

  private readAssumptions() {
    if (!this.assumptions) return;
    const road = Number(this.q<HTMLInputElement>('#va-road').value);
    this.assumptions = {
      ...this.assumptions,
      access: this.q<HTMLSelectElement>('#va-access').value as Access,
      corner: this.q<HTMLInputElement>('#va-corner').checked,
      legal: this.q<HTMLSelectElement>('#va-legal').value as LegalStatus,
      roadWideningShare: Number.isFinite(road) ? Math.min(100, Math.max(0, road)) / 100 : 0,
    };
    this.renderValuation();
  }

  private compute(): { v: Valuation; dossier: ValuationDossier } | null {
    const p = this.selected;
    const mk = this.market;
    if (!p || !mk || !this.assumptions) return null;
    const v = valueParcel(p, mk.kept, this.assumptions, { areaMedian: mk.areaMedian });
    const dossier = buildDossier({
      parcel: p,
      comparables: mk.kept,
      stats: mk.stats,
      valuation: v,
      radiusM: this.radius,
      marketSource: mk.data.source,
      snapshotTime: mk.data.generated || undefined,
    });
    return { v, dossier };
  }

  private renderValuation() {
    const out = this.q('#va-result');
    const ctrl = this.q('#va-controls');
    ctrl.hidden = !this.selected;
    this.q('#va-ai').hidden = !this.selected;
    if (!this.selected) {
      out.innerHTML = '<div class="muted small">Chọn một thửa để định giá.</div>';
      return;
    }
    const r = this.compute();
    if (!r) {
      out.innerHTML = '<div class="muted small">Đang tải giá thị trường…</div>';
      return;
    }
    const v = r.v;
    const comps = new Map(this.market!.kept.map((c) => [c.id, c]));
    const used = [...v.used].sort((a, b) => b.weight - a.weight).slice(0, 5);
    const adj = used
      .map((u) => {
        const c = comps.get(u.id);
        const head = `${c?.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(u.id)}</a>` : esc(u.id)} · ${dist(u.distance)} · ${trM2(u.raw)} → <b>${trM2(u.adjusted)}</b> · trọng số ${nf(u.weight * 100)}%`;
        const rows = u.adjustments
          .filter((a) => a.delta !== 0)
          .map((a) => `<tr><td>${esc(a.factor)}</td><td>${esc(a.subject)}</td><td>${esc(a.comp)}</td><td>${a.delta > 0 ? '+' : ''}${nf(a.delta * 100)}%</td></tr>`)
          .join('');
        return `<div class="small">${head}</div>${rows ? `<table class="land-table"><thead><tr><th>Yếu tố</th><th>Thửa này</th><th>Tin so sánh</th><th>±</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="muted small">Không cần điều chỉnh.</div>'}`;
      })
      .join('');
    const has = v.method !== 'khong-du-lieu';
    out.innerHTML =
      `<div class="land-stats"><div><b>${has ? trM2(v.pricePerM2) : '–'}</b><small>đơn giá ước tính</small></div>` +
      `<div><b>${has ? money(v.total) : '–'}</b><small>tổng giá trị</small></div>` +
      `<div><b>${has ? `${nf(v.low / 1e9, 2)}–${nf(v.high / 1e9, 2)}` : '–'}</b><small>khoảng (tỷ)</small></div></div>` +
      `<div class="small">Phương pháp: <b>${METHOD_LABEL[v.method]}</b> · độ tin cậy <b class="conf-${v.confidence}">${CONF_LABEL[v.confidence]}</b> · ${v.used.length} tin dùng, ${v.rejected.length} tin loại</div>` +
      (used.length ? `<details class="land-adj"><summary>Bảng điều chỉnh (${used.length} tin nặng nhất)</summary>${adj}</details>` : '') +
      `<ul class="land-notes">${v.notes.filter((n) => n !== DISCLAIMER).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` +
      // OSM land-use polygons are whole blocks, so a total over them is not a lot price (#39).
      (this.selected?.source === 'osm'
        ? '<div class="land-disclaimer small">Vùng này là đa giác sử dụng đất OSM (cả khu), không phải một lô đất: hãy dùng đơn giá/m², hoặc nhập thửa thật (VN2000, GeoJSON, KML) để có tổng giá đúng.</div>'
        : '') +
      `<div class="land-disclaimer small">${esc(DISCLAIMER)}</div>`;
  }

  private downloadDossier() {
    const r = this.compute();
    if (!r) return;
    const blob = new Blob([JSON.stringify(r.dossier, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tinymap-dinh-gia-${r.dossier.parcel.id.replace(/[^\w.-]+/g, '_')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private async copyMarkdown() {
    const r = this.compute();
    if (!r) return;
    const b = this.q<HTMLButtonElement>('#va-md');
    try {
      await navigator.clipboard.writeText(dossierToMarkdown(r.dossier));
      b.textContent = 'Đã sao chép ✓';
    } catch {
      b.textContent = 'Không sao chép được';
    }
    setTimeout(() => (b.textContent = 'Sao chép Markdown'), 1500);
  }

  // ---------- AI advisor (#39) ----------

  private sendFollowUp() {
    const input = this.q<HTMLInputElement>('#ai-input');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    void this.ask(q, false);
  }

  private async ask(question: string, reAsk: boolean) {
    if (this.askAbort) return; // one question at a time
    const status = this.q('#ai-status');
    let key = anthropicKey();
    if (!key || reAsk) {
      key = prompt(
        'Dán Anthropic API key (sk-ant-…).\nKey chỉ lưu trong trình duyệt này; chi phí gọi mô hình tính vào tài khoản của bạn. Để trống để xoá key.',
        key ?? '',
      );
      if (key === null) return;
      setAnthropicKey(key.trim() || null);
      this.advisor = null;
      if (!key.trim()) return void (status.textContent = 'Đã xoá key.');
    }
    const r = this.compute();
    if (!r || !this.selected || !this.market || !this.assumptions) return void (status.textContent = 'Chưa có dữ liệu định giá.');
    // A new conversation whenever the parcel, assumptions or market data changed.
    const ctxKey = `${this.selected.id}|${JSON.stringify(this.assumptions)}|${this.market.key}`;
    const out = this.q('#ai-out');
    if (!this.advisor || ctxKey !== this.advisorKey) {
      this.advisor = new Advisor({ dossier: r.dossier, parcel: this.selected, listings: this.market.data.listings, assumptions: this.assumptions });
      this.advisorKey = ctxKey;
      out.innerHTML = '';
    }
    const ac = (this.askAbort = new AbortController());
    const block = document.createElement('div');
    block.className = 'ai-turn';
    block.innerHTML = `<div class="ai-q">${esc(question)}</div><div class="ai-a"></div>`;
    out.appendChild(block);
    const ans = block.querySelector<HTMLElement>('.ai-a')!;
    let text = '';
    let raf = 0;
    const paint = () => {
      raf = 0;
      ans.innerHTML = miniMarkdown(text);
      out.scrollTop = out.scrollHeight;
    };
    this.setAsking(true);
    status.textContent = 'Đang trả lời…';
    try {
      await this.advisor.ask(
        question,
        (d) => {
          text += d;
          raf ||= requestAnimationFrame(paint);
        },
        ac.signal,
      );
      status.textContent = '';
    } catch (e) {
      status.textContent = e instanceof AdvisorError ? e.message : 'Không gọi được cố vấn AI.';
      if (e instanceof AdvisorError && e.kind === 'auth') this.advisor = null;
    } finally {
      cancelAnimationFrame(raf);
      paint();
      if (!text) block.querySelector('.ai-a')!.textContent = '';
      this.askAbort = null;
      this.setAsking(false);
    }
  }

  private setAsking(on: boolean) {
    this.q<HTMLButtonElement>('#ai-ask').disabled = on;
    this.q<HTMLButtonElement>('#ai-send').disabled = on;
    this.q('#ai-cancel').hidden = !on;
  }
}

const TEMPLATE = `
<div class="off-head"><b>Thửa đất và định giá</b><button id="land-close" class="ghost small" title="Đóng">✕</button></div>
<div class="land-tabs">
  <button data-tab="list" class="on">Thửa đất</button>
  <button data-tab="detail">Chi tiết</button>
  <button data-tab="market">Giá thị trường</button>
  <button data-tab="value">Định giá</button>
</div>
<section class="land-sec" data-sec="list">
  <div class="land-banner small">Thửa tham khảo từ lớp sử dụng đất OpenStreetMap, không phải thửa địa chính.</div>
  <div class="muted small" id="land-status"></div>
  <div class="land-legend small" id="land-legend"></div>
  <ul class="off-list land-list" id="land-list"></ul>
  <div class="off-row"><button id="land-import-toggle" class="ghost small">＋ Nhập thửa</button></div>
  <div id="land-import" class="land-import" hidden>
    <label class="small muted">Tỉnh/thành (kinh tuyến trục VN-2000)<select id="land-prov"></select></label>
    <label class="small muted">Bảng toạ độ góc thửa (STT, X, Y) từ sổ đỏ
      <textarea id="land-vn2000" rows="4" placeholder="1  1186543,21  603210,45&#10;2  1186560,02  603214,88&#10;3  …"></textarea></label>
    <label class="small muted">hoặc tệp GeoJSON / KML từ trích lục<input id="land-file" type="file" accept=".geojson,.json,.kml" /></label>
    <div class="off-row">
      <input id="land-soto" placeholder="Số tờ" inputmode="numeric" />
      <input id="land-sothua" placeholder="Số thửa" inputmode="numeric" />
    </div>
    <label class="small muted">Loại đất<select id="land-code"></select></label>
    <div class="off-row"><button id="land-import-go" class="primary small">Thêm thửa</button><span class="small muted" id="land-import-status"></span></div>
  </div>
  <div class="small land-links">Mở cổng quy hoạch chính thức:
    <a href="https://thongtinquyhoach.hochiminhcity.gov.vn/" target="_blank" rel="noopener">TP.HCM ↗</a>
    <a href="https://quyhoach.hanoi.vn/" target="_blank" rel="noopener">Hà Nội ↗</a>
  </div>
</section>
<section class="land-sec" data-sec="detail" hidden><div id="land-detail"></div></section>
<section class="land-sec" data-sec="market" hidden>
  <div class="off-row">
    <label class="small muted">Bán kính <select id="land-radius"></select></label>
    <button id="land-csv-btn" class="ghost small" title="Cột: lat, lon, dien_tich, gia hoặc gia_m2, phap_ly, vi_tri, url">Nhập CSV</button>
    <input id="land-csv" type="file" accept=".csv,.tsv,.txt" hidden />
    <button id="land-proxy" class="ghost small" title="Lấy tin mới nhất qua proxy CORS của bạn">Proxy…</button>
  </div>
  <div id="land-market"></div>
  <div class="land-disclaimer small">Giá rao bán, không phải giá giao dịch. Nguồn: Chợ Tốt Nhà.</div>
</section>
<section class="land-sec" data-sec="value" hidden>
  <div id="va-controls" class="land-assume">
    <label class="small muted">Vị trí<select id="va-access">
      ${Object.entries(ACCESS_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
    </select></label>
    <label class="small muted">Pháp lý<select id="va-legal">
      ${Object.entries(LEGAL_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
    </select></label>
    <label class="small muted">Lộ giới (% diện tích)<input id="va-road" type="number" min="0" max="100" step="1" value="0" /></label>
    <label class="small opt"><input id="va-corner" type="checkbox" /> Lô góc</label>
  </div>
  <div id="va-result"></div>
  <div class="off-row" id="va-actions">
    <button id="va-json" class="ghost small">Tải hồ sơ JSON</button>
    <button id="va-md" class="ghost small">Sao chép Markdown</button>
  </div>
  <div id="va-ai" class="land-ai">
    <div class="strong small">Trợ lý AI</div>
    <div class="muted small">Dùng key Anthropic của bạn; chi phí tính vào tài khoản của bạn. Shift + bấm để đổi key.</div>
    <div class="off-row"><button id="ai-ask" class="ghost small">🤖 Hỏi trợ lý</button><button id="ai-cancel" class="ghost small" hidden>Dừng</button><span class="small muted" id="ai-status"></span></div>
    <div id="ai-out" class="ai-out"></div>
    <div class="off-row"><input id="ai-input" placeholder="Hỏi tiếp…" autocomplete="off" /><button id="ai-send" class="ghost small">Gửi</button></div>
  </div>
</section>
`;
