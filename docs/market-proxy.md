# Proxy giá rao bán Chợ Tốt (#38)

## Vì sao cần proxy

Tiny Map chạy hoàn toàn trên trình duyệt. API công khai của Chợ Tốt Nhà (`gateway.chotot.com/v1/public/ad-listing`) chỉ trả header CORS cho `www.nhatot.com`, nên trang trên GitHub Pages không gọi trực tiếp được.

Ứng dụng có hai đường lấy dữ liệu:

1. **Bản chụp hằng ngày (mặc định).** CI chạy `npm run listings` (`tools/listings.ts`) sau mỗi lần build trên `master` và theo lịch hằng ngày, rồi ghi `dist/market/index.json` cùng `hcm.json` và `hn.json`. Repo chỉ giữ một mẫu nhỏ trong `public/market/` (khoảng 150 tin mỗi thành phố) để chạy khi dev. Không cần cấu hình gì.
2. **Proxy của riêng bạn (tuỳ chọn).** Dùng khi cần tin mới hơn bản chụp. Proxy nhận đúng query của gateway, gọi Chợ Tốt từ phía server, xoá thông tin người bán rồi trả JSON kèm header CORS cho domain của bạn.

## Cloudflare Worker mẫu

Tạo Worker mới (gói miễn phí là đủ), dán đoạn mã sau, sửa `ALLOW_ORIGIN` thành domain đang chạy Tiny Map rồi Deploy.

```js
// Proxy Chợ Tốt cho Tiny Map: GET /?<query> → gateway.chotot.com/v1/public/ad-listing?<query>
const ALLOW_ORIGIN = 'https://danny-exnodes.github.io';
const UPSTREAM = 'https://gateway.chotot.com/v1/public/ad-listing';
// Không bao giờ chuyển tiếp thông tin cá nhân, mô tả hay ảnh.
const DROP = ['account_id', 'account_name', 'account_oid', 'full_name', 'avatar', 'seller_info', 'phone',
  'body', 'subject', 'image', 'images', 'image_thumbnails', 'thumbnail_image', 'webp_image', 'videos',
  'average_rating', 'average_rating_for_seller', 'total_rating', 'total_rating_for_seller', 'is_zalo_show'];

export default {
  async fetch(req) {
    const cors = { 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Methods': 'GET', Vary: 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    const q = new URL(req.url).searchParams;
    q.set('limit', String(Math.min(50, Number(q.get('limit') || 20)))); // giữ tải thấp
    const up = await fetch(`${UPSTREAM}?${q}`, { cf: { cacheTtl: 900, cacheEverything: true } });
    if (!up.ok) return new Response(`Upstream ${up.status}`, { status: 502, headers: cors });
    const data = await up.json();
    const ads = (data.ads ?? []).map((ad) => { for (const k of DROP) delete ad[k]; return ad; });
    return Response.json({ total: data.total, ads }, { headers: { ...cors, 'Cache-Control': 'public, max-age=900' } });
  },
};
```

Worker cache mỗi query 15 phút (`cacheTtl`). Nhiều người cùng xem một khu chỉ tạo một lượt gọi tới Chợ Tốt.

## Khai báo proxy trong ứng dụng

Giao diện nhập proxy sẽ có sau. Hiện tại, mở DevTools → Console trên trang Tiny Map và chạy:

```js
localStorage.setItem('tinymap:marketProxy', 'https://ten-worker.ten-ban.workers.dev/');
```

Muốn bỏ proxy thì chạy `localStorage.removeItem('tinymap:marketProxy')`. Trong mã nguồn, giá trị này đọc và ghi qua `marketProxy()` và `setMarketProxy()` trong `src/land/market.ts`. `loadLive()` gọi proxy với cùng tham số như gateway (`cg=1040`, `st=s`, `region_v2`, `limit`, `o`), lấy vài trang tin mới nhất của thành phố rồi lọc theo bán kính trên máy.

## Lưu ý về điều khoản và dữ liệu

- Đây là **giá rao bán** (giá chào), không phải giá giao dịch thực tế. Giá rao thường cao hơn giá chốt, và toạ độ do người đăng nhập nên có thể lệch vài trăm mét.
- Dữ liệu thuộc Chợ Tốt. Hãy tôn trọng điều khoản sử dụng của Chợ Tốt:
  - chỉ dùng cho tra cứu cá nhân;
  - không đăng lại nguyên tin;
  - luôn ghi nguồn và dẫn link về tin gốc;
  - giữ tần suất gọi thấp: bản chụp CI gọi tối đa 1 request/giây, khoảng 50 request mỗi ngày.
- Không lưu và không chuyển tiếp thông tin người bán (tên, số điện thoại, ảnh đại diện), nội dung mô tả hay hình ảnh.
- Nếu Chợ Tốt yêu cầu ngừng, gỡ bước "Market listings snapshot" trong `.github/workflows/ci.yml` và xoá Worker.
