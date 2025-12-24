import axios from "axios";
import "dotenv/config";

type Ticker = {
  target_currency: string; // 예: BTC, ETH ...
  quote_currency: string; // KRW
  // 코인원 응답 필드가 환경에 따라 다를 수 있어서 넉넉히 any로 받고 아래에서 안전하게 처리
  [key: string]: any;
};

type Candle = {
  timestamp: number; // 초/밀리초일 수 있음
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;
const QUOTE_CURRENCY = process.env.QUOTE_CURRENCY ?? "KRW";
const TOP_N = Number(process.env.TOP_N ?? "5");

const STRATEGY_MODE = (process.env.STRATEGY_MODE ?? "A").toUpperCase();

const EMA_PERIOD = Number(process.env.EMA_PERIOD ?? "20");
const VOL_SMA_PERIOD = Number(process.env.VOL_SMA_PERIOD ?? "20");

const VOL_MULTIPLIER_A = Number(process.env.VOL_MULTIPLIER_A ?? "1.10");
const USE_BREAKOUT_A =
  (process.env.USE_BREAKOUT_A ?? "false").toLowerCase() === "true";
const BREAKOUT_LOOKBACK = Number(process.env.BREAKOUT_LOOKBACK ?? "20");

const PULLBACK_LOOKBACK_B = Number(process.env.PULLBACK_LOOKBACK_B ?? "5");
const PULLBACK_BAND_PCT_B = Number(process.env.PULLBACK_BAND_PCT_B ?? "0.02");
const REQUIRE_UPDAY_B =
  (process.env.REQUIRE_UPDAY_B ?? "true").toLowerCase() === "true";

function mustEnv(v: string | undefined, name: string) {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

mustEnv(TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN");
mustEnv(TELEGRAM_CHAT_ID, "TELEGRAM_CHAT_ID");

async function telegramSend(text: string) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  });
}

/**
 * 코인원: KRW 전체 티커
 * - 공식 문서/응답 필드가 바뀔 수 있어 “정렬 기준 값”을 유연하게 탐색한다.
 */
async function fetchTickersKRW(): Promise<Ticker[]> {
  const url = `https://api.coinone.co.kr/public/v2/ticker_new/${QUOTE_CURRENCY}`;
  const { data } = await axios.get(url, { timeout: 15000 });

  // data.tickers 또는 data?.result 같은 형태를 대비
  const tickers: Ticker[] = (data?.tickers ??
    data?.result ??
    data?.data ??
    []) as Ticker[];

  if (!Array.isArray(tickers)) {
    throw new Error(
      `Unexpected ticker response shape: ${JSON.stringify(data).slice(
        0,
        200
      )}...`
    );
  }

  // KRW 마켓만
  return tickers.filter(
    (t) => (t.quote_currency ?? t.quote ?? "").toUpperCase() === QUOTE_CURRENCY
  );
}

/**
 * 24h 거래대금(대략) 기준으로 상위 N개 선정
 * 코인원 티커의 필드명이 계정/버전에 따라 달라질 수 있어서 후보 키를 여러 개 둔다.
 */
function getTurnoverScore(t: Ticker): number {
  // 후보 필드들(있으면 그걸 사용)
  const candidates = [
    t.quote_volume, // 흔히 "거래대금(quote)"에 가까운 값
    t.quoteVolume,
    t.acc_quote_volume,
    t.accQuoteVolume,
    t.value, // 일부 API는 value/amount 형태
    t.acc_trade_price_24h, // 다른 거래소 스타일
    t.volume_24h
      ? Number(t.volume_24h) * Number(t.last ?? t.close ?? 0)
      : undefined, // fallback
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }

  // 최후 fallback: (24h 거래량 * 현재가)
  const vol = Number(t.volume ?? t.base_volume ?? t.baseVolume ?? 0);
  const last = Number(t.last ?? t.close ?? t.price ?? 0);
  const approx = vol * last;
  return Number.isFinite(approx) ? approx : 0;
}

async function fetchDailyCandles(
  symbol: string,
  limit = 200
): Promise<Candle[]> {
  const url = `https://api.coinone.co.kr/public/v2/chart/${QUOTE_CURRENCY}/${symbol}?interval=1d`;
  const { data } = await axios.get(url, { timeout: 15000 });

  // ✅ 코인원 v2 chart는 data.chart 에 들어옴
  const rows = (data?.chart ?? data?.data ?? data?.candles ?? []) as Array<
    Record<string, unknown>
  >;

  if (!Array.isArray(rows) || rows.length === 0) return [];

  const candles = rows
    .map((r) => ({
      timestamp: Number(r.timestamp ?? r.time ?? 0),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      // ✅ volume 키가 없고 target_volume/quote_volume이 주로 옴
      volume: Number(r.target_volume ?? r.volume ?? 0),
    }))
    .filter((c) => Number.isFinite(c.close) && c.close > 0);

  // 코인원은 최신이 앞에 올 때가 많아서 timestamp로 정렬 유지 👍
  candles.sort((a, b) => a.timestamp - b.timestamp);

  return candles.slice(-limit);
}

// ----- 지표 -----
function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  const first = values[0];
  if (first === undefined) return [];
  let prev = first;
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (v === undefined) continue;
    const cur = v * k + prev * (1 - k);
    out.push(cur);
    prev = cur;
  }
  return out;
}

function trueRange(cur: Candle, prev: Candle): number {
  const hl = cur.high - cur.low;
  const hc = Math.abs(cur.high - prev.close);
  const lc = Math.abs(cur.low - prev.close);
  return Math.max(hl, hc, lc);
}

function atr(candles: Candle[], period = 14): number[] {
  if (candles.length < 2) return [];
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    if (cur === undefined || prev === undefined) continue;
    trs.push(trueRange(cur, prev));
  }
  // TR 길이는 candles-1 이므로 align을 위해 앞에 0 추가
  const trAligned = [0, ...trs];
  return ema(trAligned, period);
}

function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const val = values[i];
    if (val === undefined) {
      out.push(NaN);
      continue;
    }
    sum += val;
    if (i >= period) {
      const prevVal = values[i - period];
      if (prevVal !== undefined) sum -= prevVal;
    }
    if (i >= period - 1) out.push(sum / period);
    else out.push(NaN);
  }
  return out;
}

type AnalysisResult = {
  symbol: string;
  isBuy: boolean;
  score: number;
  lastClose: number;
  ema20: number;
  volRatio: number;
  breakout: number;
  stop: number;
  take: number;

  // ✅ 추가: 조건 통과 집계용
  condTrend: boolean;
  condVolumeA: boolean;
  condBreakout: boolean;
};

// ----- 전략(간단 추세형) -----
// 전략 A: Close > EMA20 AND Volume > VolSMA20 * multiplier AND (옵션) 고점 돌파
// 전략 B: Pullback 전략 (EMA 근처에서 조정 후 반등)
function analyzeSymbol(
  symbol: string,
  candles: Candle[]
): AnalysisResult | null {
  if (
    candles.length <
    Math.max(EMA_PERIOD, VOL_SMA_PERIOD, BREAKOUT_LOOKBACK) + 5
  ) {
    return null;
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const emaN = ema(closes, EMA_PERIOD);
  const volSmaN = sma(volumes, VOL_SMA_PERIOD);
  const atrN = atr(candles, 14);

  const lastIdx = candles.length - 1;
  const last = candles[lastIdx];

  if (!last) return null;

  const lastClose = last.close;
  const lastEma = emaN[lastIdx] ?? NaN;
  const lastVol = last.volume;
  const lastVolSma = volSmaN[lastIdx] ?? NaN;
  const lastAtr = atrN[lastIdx] ?? NaN;

  // 고점 돌파 계산 (최근 N일 고점)
  const lookbackStart = Math.max(0, lastIdx - BREAKOUT_LOOKBACK + 1);
  const recentHighs = highs.slice(lookbackStart, lastIdx);
  const recentHigh =
    recentHighs.length > 0 ? Math.max(...recentHighs) : lastClose;
  const breakoutLevel = recentHigh;
  const isBreakout = lastClose > breakoutLevel;
  const breakoutRatio = breakoutLevel > 0 ? lastClose / breakoutLevel - 1 : 0;

  // 손절가/익절가 계산 (ATR 기반 또는 EMA 기반)
  const stopLoss =
    Number.isFinite(lastAtr) && lastAtr > 0
      ? lastClose - lastAtr * 2 // ATR 2배 하방
      : Number.isFinite(lastEma) && lastEma > 0
      ? lastEma * 0.95 // EMA의 95%
      : lastClose * 0.9; // 최후 fallback: 10% 하방

  const takeProfit =
    Number.isFinite(lastAtr) && lastAtr > 0
      ? lastClose + lastAtr * 3 // ATR 3배 상방
      : lastClose * 1.15; // fallback: 15% 상방

  const condTrend = Number.isFinite(lastEma) && lastClose > lastEma;

  const condVolumeA =
    Number.isFinite(lastVolSma) &&
    lastVolSma > 0 &&
    lastVol > lastVolSma * VOL_MULTIPLIER_A;

  const volRatio =
    Number.isFinite(lastVolSma) && lastVolSma > 0 ? lastVol / lastVolSma : NaN;

  let isBuy = false;

  let condBreakout = true;

  if (STRATEGY_MODE === "A") {
    condBreakout = USE_BREAKOUT_A ? isBreakout : true;
    isBuy = condTrend && condVolumeA && condBreakout;
  } else if (STRATEGY_MODE === "B") {
    // 전략 B: Pullback 전략
    // EMA 근처에서 조정 후 반등 + 상승일 조건
    const emaDistance =
      Number.isFinite(lastEma) && lastEma > 0
        ? Math.abs(lastClose - lastEma) / lastEma
        : Infinity;

    const isNearEma = emaDistance <= PULLBACK_BAND_PCT_B;
    const isAboveEma = Number.isFinite(lastEma) && lastClose > lastEma;

    // 최근 N일 중 상승일 체크
    let upDays = 0;
    for (
      let i = Math.max(0, lastIdx - PULLBACK_LOOKBACK_B + 1);
      i <= lastIdx;
      i++
    ) {
      const prev = candles[i - 1];
      const curr = candles[i];
      if (prev && curr && curr.close > prev.close) {
        upDays++;
      }
    }

    const hasUpDays =
      !REQUIRE_UPDAY_B || upDays >= Math.ceil(PULLBACK_LOOKBACK_B / 2);

    isBuy = isNearEma && isAboveEma && hasUpDays && condVolumeA;
  }

  const score =
    Number.isFinite(lastEma) && lastEma > 0
      ? lastClose / lastEma - 1 + (Number.isFinite(volRatio) ? volRatio - 1 : 0)
      : 0;

  return {
    symbol,
    isBuy,
    score,
    lastClose,
    ema20: lastEma,
    volRatio,
    breakout: breakoutRatio,
    stop: stopLoss,
    take: takeProfit,

    // ✅ 추가
    condTrend,
    condVolumeA,
    condBreakout,
  };
}

async function main() {
  // 1) 티커 -> 상위 50개 선정
  const tickers = await fetchTickersKRW();
  console.log("tickers length:", tickers.length);

  const sorted = [...tickers]
    .filter((t) => (t.target_currency ?? "").toUpperCase() !== "KRW")
    .sort((a, b) => getTurnoverScore(b) - getTurnoverScore(a));

  const EXCLUDE = new Set(["USDT", "USDC"]);
  const top50 = sorted
    .map((t) => String(t.target_currency).toUpperCase())
    .filter((sym) => !EXCLUDE.has(sym))
    .slice(0, 50);
  console.log("top50 length:", top50.length);
  console.log("top50 sample:", top50.slice(0, 5));

  // 2) 각 심볼 일봉 분석 (병렬 처리로 성능 개선)
  const results: AnalysisResult[] = [];
  const analysisPromises = top50.map(async (sym) => {
    try {
      const candles = await fetchDailyCandles(sym.toLowerCase(), 220);
      return analyzeSymbol(sym, candles);
    } catch (e) {
      // 실패는 스킵(알트는 간혹 데이터 구멍 있음)
      console.log("candle fetch failed:", sym, String(e));
      return null;
    }
  });

  const analysisResults = await Promise.all(analysisPromises);
  for (const r of analysisResults) {
    if (r) results.push(r);
  }

  // 3) 매수 후보 TOP_N
  const buys = results
    .filter((r) => r.isBuy)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const lines: string[] = [];
  lines.push(`[Coinone Daily Swing Summary] ${nowJst}`);
  lines.push(`Universe: KRW turnover Top 50 | Timeframe: 1D`);
  lines.push("");

  if (buys.length === 0) {
    lines.push("✅ Buy Watchlist: (none today)");
  } else {
    lines.push(`✅ Buy Watchlist (Top ${buys.length})`);
    buys.forEach((b, i) => {
      lines.push(
        `${i + 1}) ${b.symbol}
       · 현재가: ${b.lastClose.toFixed(4)}
       · 거래량 배율: ${
         Number.isFinite(b.volRatio) ? b.volRatio.toFixed(2) + "배" : "?"
       }
       · EMA20 대비: ${b.ema20.toFixed(4)}`
      );

      lines.push(
        `   ▶ 전략 참고 레벨
       - 손절 기준선: ${Number.isFinite(b.stop) ? b.stop.toFixed(4) : "?"}
       - 목표 가격대: ${Number.isFinite(b.take) ? b.take.toFixed(4) : "?"}`
      );
    });
  }

  lines.push("");
  lines.push("📌 안내");
  lines.push("※ 본 메시지는 매매 지시가 아닙니다.");
  lines.push("※ 전략 조건을 만족한 종목 참고용 알림입니다.");
  lines.push("※ 실제 매매 시 손절/비중 관리는 반드시 직접 판단하세요.");
  lines.push(
    `Mode=${STRATEGY_MODE} | EMA=${EMA_PERIOD} | VOLx(A)=${VOL_MULTIPLIER_A} | Breakout(A)=${USE_BREAKOUT_A} | PullbackBand(B)=${PULLBACK_BAND_PCT_B}`
  );
  lines.push("");

  const total = results.length;
  const passTrend = results.filter((r) => r.condTrend).length;
  const passVol = results.filter((r) => r.condVolumeA).length;

  console.log(`[COND STATS] total=${total}`);
  console.log(
    `- condTrend: ${passTrend}/${total} (${((passTrend / total) * 100).toFixed(
      1
    )}%)`
  );
  console.log(
    `- condVolumeA: ${passVol}/${total} (${((passVol / total) * 100).toFixed(
      1
    )}%)`
  );

  if (STRATEGY_MODE === "A" && USE_BREAKOUT_A) {
    const passBrk = results.filter((r) => r.condBreakout).length;
    console.log(
      `- condBreakout: ${passBrk}/${total} (${((passBrk / total) * 100).toFixed(
        1
      )}%)`
    );
  }

  const msg = lines.join("\n");
  await telegramSend(msg);
}

main().catch(async (e) => {
  const err = `ERROR: ${e?.message ?? String(e)}`;
  try {
    await telegramSend(err);
  } catch {
    console.log("telegram send failed:", err);
  }
  process.exit(1);
});
