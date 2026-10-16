// /api/order/ — 구매하기 클릭 시 아임웹(sensoria.kr)에 주문을 서버-투-서버로 만들고 결제창으로 보낸다.
// SHL 버디케인·루딕스 가이드 에디션과 같은 방식(OMS_add_order). 2026-10-14 사장님 "누르는 순간 결제페이지로".
// 랜딩 버튼이 이 주소로 폼 POST 를 보내면 브라우저가 곧장 이동하고, 여기서 303 으로 결제창에 넘긴다(중간 화면 없음).
// GET 은 받지 않는다 — 링크 미리보기 봇이 주소만 긁어도 주문이 생기고, 아임웹 전환 API 가 InitiateCheckout 을 쏴서
// 메타 데이터가 오염되기 때문이다. 폼 POST 는 사람이 눌러야만 온다.
//
// 2026-10-16: 단품도 받는다. 폼의 p 값으로 상품을 고른다(세트 28 / 단품 15~19).
// 배송 템플릿이 세트와 단품이 다르므로 상품마다 짝지어 둔다 — 값은 자사몰 상품 페이지에서 직접 읽은 것이다.

const SHOP = 'https://sensoria.kr';

// 자사몰에서 확인한 실제 값 (2026-10-16)
//   28      3종 세트 144,000원 · 배송 무료
//   15~19   단품      69,000원 · 배송 3,000원
const PRODUCTS = {
  '28': { tmpl: 'T20261007e75c042699305', name: '조이캣 비지북 3종 세트 (프린세스·오션·정글)' },
  '15': { tmpl: 'T20260706cd6e5d6ea574b', name: '조이캣 비지북 프린세스' },
  '16': { tmpl: 'T20260706cd6e5d6ea574b', name: '조이캣 비지북 오션' },
  '17': { tmpl: 'T20260706cd6e5d6ea574b', name: '조이캣 비지북 정글' },
  '18': { tmpl: 'T20260706cd6e5d6ea574b', name: '조이캣 비지북 농장' },
  '19': { tmpl: 'T20260706cd6e5d6ea574b', name: '조이캣 비지북 공룡' },
};
const DEFAULT_PROD = '28';

// 손님 브라우저가 보낸 쿠키 중 sensoria.kr 공용 쿠키(IMWEBVSSID 세션, 메타 _fbp/_fbc 등)를 아임웹에 그대로 넘긴다.
// → 주문이 손님 본인 세션으로 만들어지고(로그인 회원도 로그아웃되지 않음), 아임웹 전환 API 의 InitiateCheckout 에
//   손님 브라우저 식별값(_fbp/_fbc)이 실려 메타가 광고 클릭과 연결할 수 있다.
function pickCookies(raw) {
  return (raw || '').split(/;\s*/).filter(function (c) {
    return /^(IMWEBVSSID|_fbp|_fbc|_ga[^=]*|al)=/.test(c);
  }).join('; ');
}

// 폼 본문에서 상품 번호를 꺼낸다. 목록에 없는 값은 받지 않는다 —
// 바깥에서 아무 번호나 넣어 주문을 찍어 내지 못하게.
function readBody(req) {
  return new Promise(function (resolve) {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let raw = '';
    req.on('data', function (c) { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', function () {
      const out = {};
      try {
        new URLSearchParams(typeof req.body === 'string' ? req.body : raw)
          .forEach(function (v, k) { out[k] = v; });
      } catch (e) {}
      resolve(out);
    });
    req.on('error', function () { resolve({}); });
  });
}

async function createOrder(prod, ua, cookie) {
  const params = new URLSearchParams({
    backurl: SHOP + '/21/?idx=' + prod,
    prodIdx: prod,
    orderCount: '1',
    type: 'normal',
    deliv_type: 'parcel',
    deliv_pay_type: 'price',
    deliv_country: 'KR',
    is_gift_buy: 'false',
    shipping_template_code: PRODUCTS[prod].tmpl,
    infoUrl: SHOP,
  });
  const r = await fetch(SHOP + '/shop/oms/OMS_add_order.cm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'imweb-landing-url': SHOP + '/',
      referer: SHOP + '/21/?idx=' + prod,
      'user-agent': ua || 'Mozilla/5.0',
      ...(cookie ? { cookie: cookie } : {}),
    },
    body: params.toString(),
    signal: AbortSignal.timeout(7000),
  });
  const data = await r.json();
  // 아임웹이 주문을 만들며 내려주는 세션 쿠키(IMWEBVSSID, domain=sensoria.kr)를 손님 브라우저에 그대로 넘긴다.
  // 이게 없으면 주문의 주인이 없어서, 이미 sensoria.kr 세션(로그인)이 있는 브라우저는 결제창 대신 메인으로 튕긴다.
  // SHL 버디케인 api/order.js 와 같은 처리.
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie()
    : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
  if (!data || !data.back_url_base64) return { url: null, cookies };
  return { url: SHOP + Buffer.from(data.back_url_base64, 'base64').toString('utf-8'), cookies };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  const body = await readBody(req);
  const prod = Object.prototype.hasOwnProperty.call(PRODUCTS, String(body.p || ''))
    ? String(body.p) : DEFAULT_PROD;
  const fallback = SHOP + '/shop_view/?idx=' + prod;   // 주문 생성이 실패하면 그 상품 페이지로

  const isForm = /application\/x-www-form-urlencoded|multipart\/form-data/.test(req.headers['content-type'] || '');
  let url = null, err = null;
  try {
    const o = await createOrder(prod, req.headers['user-agent'], pickCookies(req.headers.cookie));
    url = o.url;
    if (url && o.cookies.length) res.setHeader('Set-Cookie', o.cookies);
  } catch (e) { err = String(e); }

  if (isForm) {                       // 랜딩 버튼(폼 제출): 바로 결제창으로, 실패하면 상품 페이지로
    res.statusCode = 303;
    res.setHeader('Location', url || fallback);
    res.end();
    return;
  }
  if (url) res.status(200).json({ ok: true, paymentUrl: url, prod: prod });
  else res.status(200).json({ ok: false, reason: err || 'NO_BACK_URL', prod: prod });
};
