# Relay máy bay (Cloudflare Worker)

Các nguồn dữ liệu bay miễn phí không gửi header CORS, nên trang web trên GitHub Pages phải gọi qua relay này.
Worker chỉ chuyển tiếp đúng một dạng đường dẫn (`/v2/lat/<lat>/lon/<lon>/dist/<1-250>`) tới adsb.lol (adsb.fi chặn mọi request từ Cloudflare),
chỉ trả lời cho `https://danny-exnodes.github.io` và `http://localhost:5173`, cache 10 giây.

## Triển khai (gói miễn phí)

Cách 1, wrangler:
1. `npm i -g wrangler && wrangler login`
2. Trong thư mục `proxy/`: `wrangler deploy flights-worker.js --name tinymap-flights --compatibility-date 2026-10-01`
3. Wrangler in ra địa chỉ dạng `https://tinymap-flights.<tài-khoản>.workers.dev`.

Cách 2, dashboard: Cloudflare Dashboard > Workers & Pages > Create > Worker > Edit code,
dán nội dung `flights-worker.js` rồi Deploy.

## Dùng địa chỉ đó

- Cố định cho mọi người: đặt `DEFAULT_FLIGHTS_RELAY` trong `src/data/flights.ts`.
- Thử nhanh: thêm `?flights=https://tinymap-flights.<tài-khoản>.workers.dev` vào URL,
  hoặc `localStorage.setItem('tinymap:flightsRelay', '<url>')`.

Khi chạy `npm run dev`, relay là route `/flights-api` của Vite, không cần Worker.

## Điểm ngập (💧)

Cùng Worker còn chuyển tiếp hai đường dẫn cho lớp điểm ngập (cache 60 giây):

- `/flood/hanoi` → `https://thoatnuochanoi.vn/ungngap/api/flood/getflood` (trạm đo ngập của Thoát nước Hà Nội, số đo thật);
- `/flood/hcm` → `https://bandotrieucuong.tuoitrethanhphobac.vn/api/forecasts` (dự báo nguy cơ ngập TP.HCM, Bản đồ triều cường của Tuổi Trẻ).

Hai nguồn này không có tài liệu hay giấy phép công khai: chỉ deploy hai đường này khi chủ dữ liệu đã đồng ý.
Cả hai đã được thử từ máy chủ Cloudflare (`wrangler dev --remote`, 02/11/2026): trả lời 200.
