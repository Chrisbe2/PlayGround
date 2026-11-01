import {
  CONFIG,
  closedCandles,
  selectCandidates,
  evaluateSymbol,
  btcRegime,
  indicatorSnapshot,
  backtest,
} from "./signals.mjs";

/* ------------------------------------------------------------------ *
 * Access gate
 *
 * This is a client-side demo gate, not real authentication. The check
 * below compares a SHA-256 digest so the password is not sitting in
 * plain text in the bundle.
 * ------------------------------------------------------------------ */

const ACCESS_DIGEST =
  "92611d639b51827ab5d8e19b8a9b5dda79fbad70d9b4dfab3fe0616cd2221713"; // sha256("Bombard:25755457")
const SESSION_KEY = "signalDesk.session";
const HISTORY_KEY = "signalDesk.history";
const HISTORY_LIMIT = 60;

const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const appView = $("app-view");
const loginForm = $("login-form");
const loginError = $("login-error");
const loginSubmit = $("login-submit");
const usernameInput = $("username");
const passwordInput = $("password");
const togglePassword = $("toggle-password");
const toast = $("toast");

const state = {
  scanning: false,
  scannedOnce: false,
  lastScanAt: null,
  nextScanAt: null,
  signals: [],
  history: [],
  market: [],
  regime: null,
  pairs: 0,
  timer: null,
  ticker: null,
  toastTimer: null,

  selectedSymbol: "BTCUSDT",
  chartKlines: [],
  chartTimer: null,

  newsWindow: "24h",
  announcements: [],
  announcementsAt: 0,
  marketEvents: [],
  pairLoadToken: 0,

  socket: null,
  socketSymbol: null,
  socketAttempt: 0,
  trades: [],
  livePrice: null,
  liveRenderTimer: null,
  liveStatus: "idle",

  refreshing: false,
  refreshAt: 0,

  backtest: null,
  backtestSymbol: null,
  backtestAt: 0,
  backtestLoading: false,

  accountSize: 1000,
  riskPct: 1,
};

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fmtPrice(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(5);
  if (value >= 0.0001) return value.toFixed(6);
  return value.toFixed(8);
}

function fmtCompact(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function fmtClock(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtPercent(value, digits = 2) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function fmtQty(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function fmtMoney(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1000) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  return `$${value.toFixed(2)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function setFeedStatus(kind, text) {
  state.liveStatus = kind;
  const node = $("feed-status");
  node.classList.toggle("connecting", kind === "connecting");
  node.classList.toggle("offline", kind === "offline");
  $("feed-status-text").textContent = text;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.add("show");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setLiveStatus(kind, text) {
  const node = $("live-status");
  node.classList.toggle("scanning", kind === "scanning");
  node.classList.toggle("error", kind === "error");
  $("live-status-text").textContent = text;
  const chip = $("status-chip");
  chip.classList.toggle("scanning", kind === "scanning");
  chip.classList.toggle("error", kind === "error");
  chip.textContent =
    kind === "scanning" ? "Scanning" : kind === "error" ? "Error" : "Live";
}

/* ------------------------------------------------------------------ *
 * Market data
 * ------------------------------------------------------------------ */

const API_HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
];

let apiHost = API_HOSTS[0];

async function api(path, { timeout = 15000 } = {}) {
  let lastError = null;
  for (const host of [apiHost, ...API_HOSTS.filter((h) => h !== apiHost)]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${host}${path}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      apiHost = host;
      return data;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Market data unavailable");
}

async function scan() {
  if (state.scanning) return;
  state.scanning = true;
  state.nextScanAt = nextBoundary(new Date());
  setLiveStatus("scanning", "Scanning");
  const refresh = $("refresh-btn");
  refresh.disabled = true;
  refresh.classList.add("is-scanning");
  hideBanner();
  if (!state.scannedOnce) renderSkeletons();

  try {
    const [exchangeInfo, tickers, btcKlines] = await Promise.all([
      api("/api/v3/exchangeInfo"),
      api("/api/v3/ticker/24hr", { timeout: 20000 }),
      api("/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=180"),
    ]);

    const symbols = selectCandidates(exchangeInfo, tickers, CONFIG);
    state.pairs = symbols.length;
    state.regime = btcRegime(closedCandles(btcKlines));

    const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));
    state.market = symbols
      .map((symbol) => {
        const t = tickerMap.get(symbol);
        return {
          symbol,
          volume: Number(t?.quoteVolume) || 0,
          change: Number(t?.priceChangePercent) || 0,
          price: Number(t?.lastPrice) || 0,
        };
      })
      .sort((a, b) => b.volume - a.volume);

    const results = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const rows = await api(
            `/api/v3/klines?symbol=${symbol}&interval=5m&limit=${CONFIG.klineLimit}`,
          );
          return evaluateSymbol(symbol, closedCandles(rows), CONFIG);
        } catch {
          return null;
        }
      }),
    );

    const previous = new Map(state.signals.map((s) => [s.symbol, s.candleTime]));
    const signals = results
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .map((signal) => ({
        ...signal,
        isNew: previous.get(signal.symbol) !== signal.candleTime,
      }));

    state.signals = signals;
    state.lastScanAt = new Date();
    state.nextScanAt = nextBoundary(state.lastScanAt);
    state.scannedOnce = true;

    recordHistory(signals);
    renderAll();
    setLiveStatus("ok", "Live");

    const preferred =
      signals[0]?.symbol ||
      (symbols.includes(state.selectedSymbol) ? state.selectedSymbol : symbols[0]) ||
      "BTCUSDT";
    if (preferred !== state.selectedSymbol) {
      selectSymbol(preferred);
    } else {
      loadPairData(state.selectedSymbol);
      highlightSelection();
    }

    if (signals.length === 0) {
      showBanner(
        "warning",
        `Scan complete — no setup passed every rule across ${symbols.length} pairs.`,
      );
    }
  } catch (error) {
    setLiveStatus("error", "Offline");
    const reason =
      error?.name === "AbortError"
        ? "The market data request timed out."
        : "Could not reach the Binance public API.";
    showBanner("error", `${reason} ${error?.message ? `(${error.message})` : ""}`.trim());
    if (!state.scannedOnce) renderEmpty("Market data unavailable", reason);
  } finally {
    state.scanning = false;
    refresh.disabled = false;
    refresh.classList.remove("is-scanning");
  }
}

function nextBoundary(from) {
  const ms = 5 * 60 * 1000;
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setMinutes(Math.floor(next.getMinutes() / 5) * 5 + 5);
  return new Date(next.getTime());
}

async function fetchJson(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * TradingView charts — four windows
 * ------------------------------------------------------------------ */

const CHART_TIMEFRAMES = [
  { interval: "1", label: "1m", role: "Trigger" },
  { interval: "5", label: "5m", role: "Signal" },
  { interval: "15", label: "15m", role: "Structure" },
  { interval: "240", label: "4h", role: "Context" },
];

function renderChart() {
  const symbol = state.selectedSymbol;
  const tvSymbol = `BINANCE:${symbol}`;
  $("chart-symbol").textContent = symbol;
  $("chart-link").href = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tvSymbol)}`;
  updateChartPrice();

  for (const frame of CHART_TIMEFRAMES) {
    const host = $(`tv-${frame.interval}`);
    if (!host) continue;
    host.innerHTML = `<div class="chart-loading">Loading ${frame.label} chart…</div>`;

    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";

    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    container.appendChild(widget);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.async = true;
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.textContent = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval: frame.interval,
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "rgba(6, 9, 15, 1)",
      gridColor: "rgba(148, 163, 184, 0.08)",
      hide_side_toolbar: true,
      allow_symbol_change: false,
      withdateranges: false,
      details: false,
      hotlist: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    });
    container.appendChild(script);
    host.innerHTML = "";
    host.appendChild(container);
  }

  scheduleChartFallback();
}

function scheduleChartFallback() {
  clearTimeout(state.chartTimer);
  state.chartTimer = setTimeout(() => {
    for (const frame of CHART_TIMEFRAMES) {
      const host = $(`tv-${frame.interval}`);
      if (host && !host.querySelector("iframe")) drawFallbackChart(host, frame.interval);
    }
  }, 9000);
}

async function drawFallbackChart(host, interval) {
  if (!host || host.querySelector("iframe")) return;
  const symbol = state.selectedSymbol;
  const label = interval === "240" ? "4h" : `${interval}m`;
  const link = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(
    `BINANCE:${symbol}`,
  )}&interval=${interval}`;
  host.innerHTML = `<div class="chart-loading">Loading Binance ${label} chart…</div>`;

  try {
    const rows = await api(
      `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=200`,
    );
    if (symbol !== state.selectedSymbol || host.querySelector("iframe")) return;

    const closes = closedCandles(rows).map((candle) => candle.close);
    if (closes.length < 2) throw new Error("no data");

    const min = Math.min(...closes);
    const max = Math.max(...closes);
    const span = max - min || 1;
    const width = 400;
    const height = 200;
    const pad = 8;
    const points = closes
      .map((value, index) => {
        const x = pad + (index / (closes.length - 1)) * (width - pad * 2);
        const y = pad + (1 - (value - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const rising = closes.at(-1) >= closes[0];
    const stroke = rising ? "#38e0a0" : "#ff6b7a";

    host.innerHTML = `
      <div class="chart-fallback">
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="${escapeHtml(
          symbol,
        )} ${label} closes">
          <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke"></polyline>
        </svg>
        <span>Binance ${label} closes · <a href="${link}" target="_blank" rel="noopener">Open TradingView ↗</a></span>
      </div>`;
  } catch {
    host.innerHTML = `<div class="chart-loading">TradingView unavailable. <a href="${link}" target="_blank" rel="noopener">Open ${label} chart ↗</a></div>`;
  }
}

function updateChartPrice() {
  const row = state.market.find((item) => item.symbol === state.selectedSymbol);
  const price = state.livePrice ?? row?.price;
  const change = row?.change;
  $("chart-price").textContent = price ? `$${fmtPrice(price)}` : "—";
  const node = $("chart-change");
  if (!Number.isFinite(change)) {
    node.textContent = "—";
    node.classList.remove("up", "down");
    return;
  }
  node.textContent = fmtPercent(change);
  node.classList.toggle("up", change >= 0);
  node.classList.toggle("down", change < 0);
}

/* ------------------------------------------------------------------ *
 * Live trade tape
 * ------------------------------------------------------------------ */

const STREAM_HOSTS = [
  "wss://stream.binance.com:9443/ws",
  "wss://data-stream.binance.vision/ws",
];

function connectLive(symbol) {
  disconnectLive();
  state.socketSymbol = symbol;
  state.socketAttempt = 0;
  state.trades = [];
  state.livePrice = null;
  openSocket();
}

function openSocket() {
  const symbol = state.socketSymbol;
  if (!symbol) return;
  if (state.socketAttempt >= STREAM_HOSTS.length) {
    setFeedStatus("offline", "Polling");
    return;
  }

  const host = STREAM_HOSTS[state.socketAttempt];
  let socket;
  try {
    socket = new WebSocket(`${host}/${symbol.toLowerCase()}@trade`);
  } catch {
    state.socketAttempt += 1;
    openSocket();
    return;
  }

  state.socket = socket;
  setFeedStatus("connecting", "Connecting");

  const failTimer = setTimeout(() => {
    if (state.socket === socket && socket.readyState !== WebSocket.OPEN) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  }, 6000);

  socket.addEventListener("open", () => {
    clearTimeout(failTimer);
    if (state.socket !== socket) return;
    state.socketAttempt = 0;
    setFeedStatus("live", "Live");
  });

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    try {
      const data = JSON.parse(event.data);
      if (data.e === "trade") handleTrade(data);
    } catch {
      /* ignore malformed frames */
    }
  });

  socket.addEventListener("close", () => {
    clearTimeout(failTimer);
    if (state.socket !== socket) return;
    state.socket = null;
    if (state.socketSymbol !== symbol) return;
    state.socketAttempt += 1;
    if (state.socketAttempt < STREAM_HOSTS.length) {
      setFeedStatus("connecting", "Reconnecting");
      setTimeout(() => {
        if (state.socketSymbol === symbol && !state.socket) openSocket();
      }, 800);
    } else {
      setFeedStatus("offline", "Polling");
    }
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  });
}

function disconnectLive() {
  const socket = state.socket;
  state.socket = null;
  state.socketSymbol = null;
  if (socket) {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}

function handleTrade(data) {
  const price = Number(data.p);
  const quantity = Number(data.q);
  if (!Number.isFinite(price)) return;
  state.livePrice = price;
  state.trades.unshift({
    price,
    quantity,
    side: data.m ? "sell" : "buy",
    ts: Number(data.T) || Date.now(),
  });
  if (state.trades.length > 14) state.trades.length = 14;
  updateChartPrice();
  scheduleLiveRender();
}

function scheduleLiveRender() {
  if (state.newsWindow !== "live" || state.liveRenderTimer) return;
  state.liveRenderTimer = setTimeout(() => {
    state.liveRenderTimer = null;
    renderLiveTape();
  }, 450);
}

function renderLiveTape() {
  const list = $("news-list");
  const row = state.market.find((item) => item.symbol === state.selectedSymbol);
  const price = state.livePrice ?? row?.price;
  const change = row?.change;
  const trades = state.trades.slice(0, 10);
  const changeClass = Number.isFinite(change) && change >= 0 ? "up" : "down";

  list.innerHTML = `
    <div class="tape-head">
      <div>
        <span class="mini-label">Last price</span>
        <strong class="tape-price">${price ? fmtPrice(price) : "—"}</strong>
      </div>
      <span class="tape-change ${changeClass}">${Number.isFinite(change) ? fmtPercent(change) : "—"}</span>
    </div>
    ${
      trades.length
        ? `<div class="tape-rows">${trades
            .map(
              (trade) => `
          <div class="tape-row">
            <span class="${trade.side === "buy" ? "up" : "down"}">${trade.side === "buy" ? "BUY" : "SELL"}</span>
            <span>${fmtPrice(trade.price)}</span>
            <span>${fmtQty(trade.quantity)}</span>
            <span>${fmtClock(new Date(trade.ts))}</span>
          </div>`,
            )
            .join("")}</div>`
        : '<p class="muted">Waiting for live trade prints…</p>'
    }
    <p class="tape-note">${
      state.liveStatus === "live"
        ? "Streaming Binance trade prints for this pair."
        : "Live stream unavailable — showing the last scan price."
    }</p>`;
}

/* ------------------------------------------------------------------ *
 * Announcements + pair events
 * ------------------------------------------------------------------ */

const BASE_NAMES = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  BNB: "BNB",
  SOL: "Solana",
  XRP: "XRP",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  TRX: "Tron",
  AVAX: "Avalanche",
  LINK: "Chainlink",
  DOT: "Polkadot",
  MATIC: "Polygon",
  LTC: "Litecoin",
  BCH: "Bitcoin Cash",
  SHIB: "Shiba Inu",
  PEPE: "Pepe",
  SUI: "Sui",
  APT: "Aptos",
  ARB: "Arbitrum",
  OP: "Optimism",
  TON: "Toncoin",
  NEAR: "NEAR",
  ATOM: "Cosmos",
  FIL: "Filecoin",
  UNI: "Uniswap",
  AAVE: "Aave",
  ETC: "Ethereum Classic",
  XLM: "Stellar",
  ALGO: "Algorand",
  VET: "VeChain",
  ICP: "Internet Computer",
  INJ: "Injective",
  SEI: "Sei",
  TIA: "Celestia",
  JUP: "Jupiter",
  WIF: "dogwifhat",
  BONK: "Bonk",
};

function catalogKind(name = "") {
  if (/listing/i.test(name)) return { label: "Listing", cls: "listing" };
  if (/delist/i.test(name)) return { label: "Delisting", cls: "delisting" };
  if (/maintenance/i.test(name)) return { label: "Maintenance", cls: "exchange" };
  if (/airdrop/i.test(name)) return { label: "Airdrop", cls: "promo" };
  if (/activit|promo/i.test(name)) return { label: "Promo", cls: "promo" };
  if (/api/i.test(name)) return { label: "API", cls: "exchange" };
  return { label: "Exchange", cls: "exchange" };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pairKeywords(symbol) {
  const base = symbol.replace(/USDT$/, "");
  const keywords = new Set([base.toLowerCase()]);
  if (BASE_NAMES[base]) keywords.add(BASE_NAMES[base].toLowerCase());
  return [...keywords];
}

function mentionsPair(title, symbol) {
  const text = title.toLowerCase();
  return pairKeywords(symbol).some((word) =>
    new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(text),
  );
}

async function loadAnnouncements() {
  if (state.announcements.length && Date.now() - state.announcementsAt < 5 * 60 * 1000) {
    return state.announcements;
  }
  try {
    const payload = await fetchJson(
      "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=40",
    );
    const catalogs = payload?.data?.catalogs || [];
    const items = [];
    for (const catalog of catalogs) {
      const kind = catalogKind(catalog.catalogName);
      for (const article of catalog.articles || []) {
        if (!article?.title || !article?.code) continue;
        items.push({
          id: `bn-${article.id}`,
          kind,
          title: article.title,
          ts: Number(article.releaseDate) || 0,
          url: `https://www.binance.com/en/support/announcement/${article.code}`,
        });
      }
    }
    state.announcements = items.filter((item) => item.ts > 0).sort((a, b) => b.ts - a.ts);
    state.announcementsAt = Date.now();
  } catch {
    /* keep any cached headlines; market events still fill the feed */
  }
  return state.announcements;
}

function buildMarketEvents(symbol, candles) {
  const events = [];
  if (!candles || candles.length < 12) return events;
  const now = Date.now();
  const windows = [
    { key: "24h", ms: 86400000, label: "24 hours", scope: ["24h"] },
    { key: "4h", ms: 14400000, label: "4 hours", scope: ["24h", "4h"] },
    { key: "1h", ms: 3600000, label: "hour", scope: ["24h", "4h", "1h"] },
  ];

  for (const window of windows) {
    const slice = candles.filter((candle) => candle.closeTime > now - window.ms);
    if (slice.length < 2) continue;
    const first = slice[0];
    const last = slice.at(-1);
    const change = (last.close / first.open - 1) * 100;
    const high = Math.max(...slice.map((candle) => candle.high));
    const low = Math.min(...slice.map((candle) => candle.low));
    const volume = slice.reduce((sum, candle) => sum + candle.quoteVolume, 0);
    const previous = candles.filter(
      (candle) =>
        candle.closeTime <= now - window.ms &&
        candle.closeTime > now - window.ms * 2,
    );
    const previousVolume = previous.reduce((sum, candle) => sum + candle.quoteVolume, 0);
    const volumeRatio = previousVolume > 0 ? volume / previousVolume : null;

    events.push({
      id: `mkt-${symbol}-${window.key}-move`,
      ts: last.closeTime,
      scope: window.scope,
      tag: `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`,
      cls: change >= 0 ? "up" : "down",
      title: `${symbol} is ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(2)}% over the last ${window.label}, trading at ${fmtPrice(last.close)}.`,
      source: "Market data",
    });

    if (volumeRatio && volumeRatio >= 1.25) {
      events.push({
        id: `mkt-${symbol}-${window.key}-volume`,
        ts: last.closeTime,
        scope: window.scope,
        tag: `${volumeRatio.toFixed(2)}× volume`,
        cls: "exchange",
        title: `Volume is ${volumeRatio.toFixed(2)}× the previous ${window.label} (${fmtCompact(volume)} quoted).`,
        source: "Market data",
      });
    }

    const range = high - low;
    if (range > 0) {
      const position = (last.close - low) / range;
      if (position >= 0.85) {
        events.push({
          id: `mkt-${symbol}-${window.key}-high`,
          ts: last.closeTime,
          scope: window.scope,
          tag: "Near high",
          cls: "up",
          title: `Price is holding near the top of its ${window.label} range — ${fmtPrice(high)} high, ${fmtPrice(low)} low.`,
          source: "Market data",
        });
      } else if (position <= 0.15) {
        events.push({
          id: `mkt-${symbol}-${window.key}-low`,
          ts: last.closeTime,
          scope: window.scope,
          tag: "Near low",
          cls: "down",
          title: `Price is pressing the bottom of its ${window.label} range — ${fmtPrice(low)} low, ${fmtPrice(high)} high.`,
          source: "Market data",
        });
      }
    }
  }

  const signal = state.signals.find((item) => item.symbol === symbol);
  if (signal) {
    events.push({
      id: `sig-${symbol}-${signal.candleTime}`,
      ts: signal.candleTime,
      scope: ["24h", "4h", "1h"],
      tag: `${signal.score}/100`,
      cls: "listing",
      title: `Scanner flagged ${signal.side.toUpperCase()} · ${signal.setup} at ${fmtPrice(signal.entry)}.`,
      source: "Signal desk",
    });
  }

  return events.sort((a, b) => b.ts - a.ts);
}

function newsItems(windowKey) {
  const now = Date.now();
  const maxAge = windowKey === "24h" ? 86400000 : windowKey === "4h" ? 14400000 : 3600000;
  const matched = state.announcements.filter(
    (item) => now - item.ts <= maxAge && mentionsPair(item.title, state.selectedSymbol),
  );
  const pool = matched.length
    ? matched
    : state.announcements.filter((item) => now - item.ts <= maxAge).slice(0, 3);

  const headlines = pool.map((item) => ({
    id: item.id,
    ts: item.ts,
    tag: matched.length ? item.kind.label : "Market-wide",
    cls: matched.length ? item.kind.cls : "exchange",
    title: item.title,
    source: "Binance announcement",
    url: item.url,
  }));

  const events = state.marketEvents.filter((event) => event.scope.includes(windowKey));
  return [...headlines, ...events].sort((a, b) => b.ts - a.ts).slice(0, 8);
}

function renderNews() {
  $("news-symbol").textContent = state.selectedSymbol;
  const list = $("news-list");
  if (state.newsWindow === "live") {
    renderLiveTape();
    return;
  }

  const items = newsItems(state.newsWindow);
  if (!items.length) {
    list.innerHTML = `<p class="muted">No updates for ${escapeHtml(
      state.selectedSymbol,
    )} in the last ${state.newsWindow} yet. The feed refreshes with each scan.</p>`;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const inner = `
        <div class="news-item-top">
          <span class="news-tag ${item.cls}">${escapeHtml(item.tag)}</span>
          <span class="news-time">${timeAgo(item.ts)}</span>
        </div>
        <p>${escapeHtml(item.title)}</p>
        <span class="news-source">${escapeHtml(item.source)}</span>`;
      return item.url
        ? `<a class="news-item" href="${item.url}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="news-item">${inner}</div>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ *
 * Pair selection
 * ------------------------------------------------------------------ */

function selectSymbol(symbol) {
  if (!symbol) return;
  const changed = symbol !== state.selectedSymbol;
  state.selectedSymbol = symbol;
  if (changed) {
    state.chartKlines = [];
    state.marketEvents = [];
    state.livePrice = null;
    state.trades = [];
  }
  $("news-symbol").textContent = symbol;
  $("indicator-pair").textContent = symbol;
  $("ticket-symbol").textContent = symbol;
  highlightSelection();
  renderChart();
  renderIndicators();
  renderTicket();
  renderNews();
  connectLive(symbol);
  loadPairData(symbol);
  runBacktest(symbol);
}

function highlightSelection() {
  document.querySelectorAll("[data-symbol]").forEach((node) => {
    node.classList.toggle("is-selected", node.dataset.symbol === state.selectedSymbol);
  });
}

async function loadPairData(symbol) {
  const token = ++state.pairLoadToken;
  const [klinesResult] = await Promise.allSettled([
    api(`/api/v3/klines?symbol=${symbol}&interval=5m&limit=300`),
    loadAnnouncements(),
  ]);
  if (token !== state.pairLoadToken) return;

  if (klinesResult.status === "fulfilled") {
    state.chartKlines = closedCandles(klinesResult.value);
    state.marketEvents = buildMarketEvents(symbol, state.chartKlines);
  } else {
    state.chartKlines = [];
    state.marketEvents = [];
  }

  renderIndicators();
  renderTicket();
  renderNews();
  updateChartPrice();
}

/* ------------------------------------------------------------------ *
 * Indicator stack
 * ------------------------------------------------------------------ */

function renderIndicators() {
  $("indicator-pair").textContent = state.selectedSymbol;
  const grid = $("indicator-grid");
  const verdict = $("indicator-verdict");
  const snapshot = indicatorSnapshot(state.chartKlines, CONFIG);
  const signal = state.signals.find((item) => item.symbol === state.selectedSymbol);
  const liquidity = state.market.find((item) => item.symbol === state.selectedSymbol);

  verdict.classList.toggle("qualified", Boolean(signal));
  if (signal) {
    verdict.textContent = `${signal.side.toUpperCase()} · ${signal.score}/100`;
  } else if (!snapshot) {
    verdict.textContent = "Waiting for data";
  } else {
    verdict.textContent = "No qualifying setup";
  }

  if (!snapshot) {
    grid.innerHTML = `<p class="indicator-empty">Loading indicator values for ${escapeHtml(
      state.selectedSymbol,
    )}…</p>`;
    return;
  }

  const trendUp = snapshot.trend === "up";
  const atrInRange =
    snapshot.atrPct >= snapshot.minAtrPct && snapshot.atrPct <= snapshot.maxAtrPct;
  const rsiIdeal = snapshot.rsi >= 50 && snapshot.rsi <= 72;
  const volumeConfirmed =
    snapshot.volumeRatio != null && snapshot.volumeRatio >= snapshot.minVolumeRatio;
  const strongClose = snapshot.closePosition >= 0.65;
  const weakClose = snapshot.closePosition <= 0.35;
  const supportDistance = ((snapshot.price - snapshot.support) / snapshot.price) * 100;
  const resistanceDistance = ((snapshot.resistance - snapshot.price) / snapshot.price) * 100;
  const liquidityEligible =
    Boolean(liquidity) && liquidity.volume >= CONFIG.minQuoteVolume;

  const cards = [
    {
      name: "EMA 20",
      state: trendUp ? "Above EMA 50" : "Below EMA 50",
      cls: trendUp ? "up" : "down",
      value: fmtPrice(snapshot.ema20),
      sub: `Fast trend · ${snapshot.trendSpreadPct >= 0 ? "+" : ""}${snapshot.trendSpreadPct.toFixed(2)}% vs EMA 50`,
      role: "Short-term trend filter",
      reason:
        "Long setups only fire while EMA 20 sits above EMA 50. It keeps the desk on the side of the immediate trend instead of buying into a falling market.",
    },
    {
      name: "EMA 50",
      state: trendUp ? "Rising base" : "Falling base",
      cls: trendUp ? "up" : "down",
      value: fmtPrice(snapshot.ema50),
      sub: "Slow trend baseline",
      role: "Trend backbone",
      reason:
        "The 50-period EMA defines the slower trend. The gap between EMA 20 and EMA 50 also feeds the confluence score, so stronger separation earns a higher score.",
    },
    {
      name: "ATR 14",
      state: atrInRange
        ? "In range"
        : snapshot.atrPct < snapshot.minAtrPct
          ? "Too quiet"
          : "Too wild",
      cls: atrInRange ? "ok" : "warn",
      value: `${snapshot.atrPct.toFixed(2)}%`,
      sub: `${fmtPrice(snapshot.atr)} per candle`,
      role: "Volatility filter",
      reason: `Average true range must stay between ${snapshot.minAtrPct.toFixed(
        2,
      )}% and ${snapshot.maxAtrPct.toFixed(
        2,
      )}% of price. It removes dead pairs and runaway candles, and sets the stop at 1.5× ATR.`,
    },
    {
      name: "RSI 14",
      state: rsiIdeal ? "Momentum OK" : snapshot.rsi > 72 ? "Overbought" : "Weak",
      cls: rsiIdeal ? "ok" : snapshot.rsi > 72 ? "mid" : "warn",
      value: snapshot.rsi.toFixed(1),
      sub: "Relative strength",
      role: "Momentum confirmation",
      reason:
        "Breakouts need RSI between 50 and 72; support rejections need 40 to 65. The band confirms momentum without chasing an exhausted, overbought move.",
    },
    {
      name: "Volume ratio",
      state: volumeConfirmed ? "Confirmed" : "Thin",
      cls: volumeConfirmed ? "ok" : "mid",
      value: snapshot.volumeRatio != null ? `${snapshot.volumeRatio.toFixed(2)}×` : "—",
      sub: `${snapshot.volumePeriod}-candle average · ${fmtCompact(snapshot.currentVolume)} now`,
      role: "Participation check",
      reason: `The signal candle must trade at least ${snapshot.minVolumeRatio.toFixed(
        1,
      )}× the prior ${snapshot.volumePeriod}-candle average. Volume is the evidence that the move has real participation behind it.`,
    },
    {
      name: "Support",
      state: `${supportDistance.toFixed(2)}% below`,
      cls: "mid",
      value: fmtPrice(snapshot.support),
      sub: `${snapshot.srLookback}-candle low`,
      role: "Stop anchor · rejection zone",
      reason:
        "Support is the lowest low of the prior 48 candles. Rejection setups need price to reclaim it, and the stop is placed 0.15× ATR below it so normal noise does not trigger an exit.",
    },
    {
      name: "Resistance",
      state: `${resistanceDistance.toFixed(2)}% above`,
      cls: "mid",
      value: fmtPrice(snapshot.resistance),
      sub: `${snapshot.srLookback}-candle high`,
      role: "Breakout trigger",
      reason:
        "Resistance is the highest high of the prior 48 candles. A fresh close above it is the breakout trigger, and the stop sits just below the broken level.",
    },
    {
      name: "Candle structure",
      state: strongClose ? "Strong close" : weakClose ? "Weak close" : "Balanced",
      cls: strongClose ? "up" : weakClose ? "down" : "mid",
      value: `${(snapshot.closePosition * 100).toFixed(0)}%`,
      sub: snapshot.candleClose >= snapshot.candleOpen ? "Bullish body" : "Bearish body",
      role: "Close quality",
      reason:
        "A bullish rejection needs the close in the top 65% of the candle range. It filters out setups where price pokes above a level and then gives it back.",
    },
    {
      name: "Liquidity",
      state: liquidityEligible ? "Eligible" : "Below floor",
      cls: liquidityEligible ? "ok" : "warn",
      value: liquidity ? fmtCompact(liquidity.volume) : "—",
      sub: `24h quote volume · floor ${fmtCompact(CONFIG.minQuoteVolume)}`,
      role: "Universe filter",
      reason:
        "Only USDT spot pairs above the 24-hour quote-volume floor enter the scan. Thin books produce unreliable breakouts and poor fills.",
    },
    {
      name: "Confluence score",
      state: signal ? "Qualified" : "Below 70",
      cls: signal ? "qualified" : "mid",
      value: signal ? `${signal.score}/100` : "—",
      sub: `Minimum ${snapshot.minScore}/100`,
      role: "Final gate",
      reason:
        "The score adds volume expansion and trend separation to the base setup weight. A setup only reaches the desk when it clears the 70-point threshold.",
    },
  ];

  grid.innerHTML = cards
    .map(
      (card) => `
      <article class="indicator-card">
        <div class="indicator-top">
          <span class="indicator-name">${card.name}</span>
          <span class="indicator-state ${card.cls}">${card.state}</span>
        </div>
        <strong class="indicator-value">${card.value}</strong>
        <span class="indicator-sub">${card.sub}</span>
        <p class="indicator-role">${card.role}</p>
        <p class="indicator-reason">${card.reason}</p>
      </article>`,
    )
    .join("");
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderSkeletons() {
  $("signals").innerHTML = Array.from({ length: 2 })
    .map(
      () => `
      <article class="signal-card skeleton">
        <div class="sk-line w-30"></div>
        <div class="sk-line w-55"></div>
        <div class="sk-block"></div>
        <div class="sk-row">
          <div class="sk-block"></div><div class="sk-block"></div>
          <div class="sk-block"></div><div class="sk-block"></div>
        </div>
      </article>`,
    )
    .join("");
}

function renderAll() {
  renderSignals();
  renderStats();
  renderStatus();
  renderMarket();
  renderRegime();
  renderHistory();
  renderTicket();
}

function renderSignals() {
  const container = $("signals");
  const count = state.signals.length;
  $("signal-count").textContent = String(count);

  if (count === 0) {
    renderEmpty(
      "No qualifying setup",
      "The scanner checked every pair and none met the full confluence rule set. That is a valid result — the desk only speaks when a setup qualifies.",
    );
    $("scan-summary").textContent = state.lastScanAt
      ? `${state.pairs} pairs · ${fmtClock(state.lastScanAt)}`
      : "Waiting for first scan";
    return;
  }

  container.innerHTML = state.signals
    .map((signal, index) => signalCard(signal, index))
    .join("");

  $("scan-summary").textContent = `${count} from ${state.pairs} pairs · ${fmtClock(
    state.lastScanAt,
  )}`;
}

function renderEmpty(title, copy) {
  $("signals").innerHTML = `
    <div class="empty-state">
      <div class="radar" aria-hidden="true"><span></span><span></span><span></span><i class="radar-core"></i></div>
      <h3>${title}</h3>
      <p>${copy}</p>
      <div class="empty-actions">
        <button class="btn-primary small js-scan" type="button">Scan now</button>
        <span>Next automatic scan ${state.nextScanAt ? fmtClock(state.nextScanAt) : "soon"}</span>
      </div>
    </div>`;
  $("signal-count").textContent = "0";
}

function signalCard(signal, index) {
  const isLong = signal.side === "long";
  const risk = Math.abs(signal.entry - signal.stop);
  const reward = Math.abs(signal.takeProfit1 - signal.entry);
  const rr = risk > 0 ? reward / risk : 0;
  const atrPct = (signal.atr / signal.entry) * 100;
  const circumference = 2 * Math.PI * 28;
  const offset = circumference * (1 - signal.score / 100);

  return `
    <article class="signal-card ${isLong ? "long" : "short"}${
      signal.symbol === state.selectedSymbol ? " is-selected" : ""
    }" data-symbol="${signal.symbol}" tabindex="0" role="button" aria-label="Load ${signal.symbol} trade plan" style="--delay:${index * 70}ms">
      <div class="signal-head">
        <div>
          <div class="symbol-line">
            <h3>${signal.symbol}</h3>
            <span class="side-pill ${isLong ? "long" : "short"}">${signal.side.toUpperCase()}</span>
            ${signal.isNew ? '<span class="new-badge">NEW</span>' : ""}
          </div>
          <p class="setup">${signal.setup}</p>
        </div>
        <div class="score-ring" title="Confluence score">
          <svg viewBox="0 0 66 66" aria-hidden="true">
            <circle class="ring-track" cx="33" cy="33" r="28"></circle>
            <circle class="ring-value" cx="33" cy="33" r="28"
              stroke-dasharray="${circumference.toFixed(1)}"
              stroke-dashoffset="${offset.toFixed(1)}"></circle>
          </svg>
          <div class="score-text"><strong>${signal.score}</strong><span>/100</span></div>
        </div>
      </div>

      <div class="levels-grid">
        <div class="level entry"><span>Entry</span><strong>${fmtPrice(signal.entry)}</strong></div>
        <div class="level stop"><span>Stop</span><strong>${fmtPrice(signal.stop)}</strong></div>
        <div class="level tp"><span>Target 1R</span><strong>${fmtPrice(signal.takeProfit1)}</strong></div>
        <div class="level tp"><span>Target 2R</span><strong>${fmtPrice(signal.takeProfit2)}</strong></div>
      </div>

      <div class="metrics-grid">
        <div><span>ATR</span><strong>${atrPct.toFixed(2)}%</strong></div>
        <div><span>RSI 14</span><strong>${signal.rsi.toFixed(1)}</strong></div>
        <div><span>Volume</span><strong>${signal.volumeRatio.toFixed(2)}×</strong></div>
        <div><span>Reward</span><strong>${rr.toFixed(1)}R</strong></div>
      </div>

      <div class="signal-body">
        <div class="reasons">
          <span class="mini-label">Why it qualified</span>
          <ul>
            ${signal.reasons
              .map(
                (reason) =>
                  `<li><svg class="icon"><use href="#i-check"/></svg><span>${reason}</span></li>`,
              )
              .join("")}
          </ul>
        </div>
        <div class="structure">
          <span class="mini-label">Structure</span>
          <div class="structure-row"><span>Support</span><strong>${fmtPrice(signal.support)}</strong></div>
          <div class="structure-row"><span>Resistance</span><strong>${fmtPrice(signal.resistance)}</strong></div>
          <div class="structure-row"><span>Risk / unit</span><strong>${fmtPrice(risk)}</strong></div>
          <div class="structure-row"><span>Candle close</span><strong>${fmtClock(new Date(signal.candleTime))}</strong></div>
        </div>
      </div>

      <div class="signal-foot">
        <span class="signal-time">
          <svg class="icon"><use href="#i-clock"/></svg>
          Closed candle · ${new Date(signal.candleTime).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <button class="copy-btn" type="button" data-copy="${signal.symbol}">
          <svg class="icon"><use href="#i-copy"/></svg>
          <span>Copy setup</span>
        </button>
      </div>
    </article>`;
}

function renderStats() {
  const signals = state.signals;
  $("stat-pairs").textContent = state.pairs ? String(state.pairs) : "—";
  $("stat-signals").textContent = state.scannedOnce ? String(signals.length) : "—";
  $("stat-score").textContent = signals.length
    ? `${Math.round(signals.reduce((sum, s) => sum + s.score, 0) / signals.length)}`
    : state.scannedOnce
      ? "—"
      : "—";

  const regimeNode = $("stat-regime");
  if (state.regime) {
    regimeNode.textContent = state.regime.trend;
    regimeNode.classList.toggle("regime-up", state.regime.trend === "Bullish");
    regimeNode.classList.toggle("regime-down", state.regime.trend === "Bearish");
    $("stat-regime-detail").textContent = `RSI ${state.regime.rsi.toFixed(1)}`;
  } else {
    regimeNode.textContent = "—";
    $("stat-regime-detail").textContent = "waiting for data";
  }
}

function renderStatus() {
  $("status-universe").textContent = state.pairs ? `${state.pairs} pairs` : "—";
  $("status-last-scan").textContent = state.lastScanAt
    ? fmtClock(state.lastScanAt)
    : "—";
  $("status-next-scan").textContent = state.nextScanAt
    ? fmtClock(state.nextScanAt)
    : "—";
  $("last-scan").textContent = state.lastScanAt ? fmtClock(state.lastScanAt) : "—";
}

function renderMarket() {
  const list = $("market-list");
  if (!state.market.length) {
    list.innerHTML = '<p class="muted">Waiting for market data.</p>';
    $("movers").innerHTML = "";
    return;
  }

  list.innerHTML = state.market
    .slice(0, 6)
    .map(
      (item) => `
      <div class="market-row${item.symbol === state.selectedSymbol ? " is-selected" : ""}" data-symbol="${item.symbol}" tabindex="0" role="button" aria-label="Load ${item.symbol} trade plan">
        <div class="market-id"><strong>${item.symbol.replace("USDT", "")}</strong><span>USDT</span></div>
        <div class="market-quote">
          <strong>${fmtCompact(item.volume)}</strong>
          <span class="${item.change >= 0 ? "up" : "down"}">${fmtPercent(item.change)}</span>
        </div>
      </div>`,
    )
    .join("");

  const ranked = [...state.market].sort((a, b) => b.change - a.change);
  const movers = [...ranked.slice(0, 2), ...ranked.slice(-2)];
  $("movers").innerHTML = movers
    .map(
      (item) => `
      <span class="mover-chip">
        ${item.symbol.replace("USDT", "")}
        <strong class="${item.change >= 0 ? "up" : "down"}">${fmtPercent(item.change, 1)}</strong>
      </span>`,
    )
    .join("");
}

function renderRegime() {
  const badge = $("btc-trend");
  if (!state.regime) {
    badge.textContent = "—";
    badge.classList.remove("up", "down");
    $("btc-price").textContent = "—";
    $("btc-rsi").textContent = "—";
    $("btc-ema20").textContent = "—";
    $("btc-ema50").textContent = "—";
    return;
  }
  const up = state.regime.trend === "Bullish";
  badge.textContent = state.regime.trend;
  badge.classList.toggle("up", up);
  badge.classList.toggle("down", !up);
  $("btc-price").textContent = `$${fmtPrice(state.regime.price)}`;
  $("btc-rsi").textContent = state.regime.rsi.toFixed(1);
  $("btc-ema20").textContent = fmtPrice(state.regime.ema20);
  $("btc-ema50").textContent = fmtPrice(state.regime.ema50);
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    state.history = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.history)) state.history = [];
  } catch {
    state.history = [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(0, HISTORY_LIMIT)));
  } catch {
    /* storage may be unavailable; history is a convenience only */
  }
}

function recordHistory(signals) {
  if (!signals.length) return;
  const known = new Set(state.history.map((item) => `${item.symbol}:${item.candleTime}`));
  const fresh = signals.filter((s) => !known.has(`${s.symbol}:${s.candleTime}`));
  if (!fresh.length) return;
  state.history = [
    ...fresh.map((s) => ({
      symbol: s.symbol,
      side: s.side,
      setup: s.setup,
      score: s.score,
      entry: s.entry,
      candleTime: s.candleTime,
      seenAt: Date.now(),
    })),
    ...state.history,
  ].slice(0, HISTORY_LIMIT);
  saveHistory();
}

function renderHistory() {
  const container = $("history");
  if (!state.history.length) {
    container.innerHTML = '<p class="muted">No signals logged yet this session.</p>';
    return;
  }
  container.innerHTML = state.history
    .slice(0, 12)
    .map(
      (item) => `
      <div class="history-row">
        <div class="history-symbol">
          <span class="side-dot ${item.side}"></span>
          <strong>${item.symbol}</strong>
          <span>${item.setup}</span>
        </div>
        <div class="history-meta">
          <strong>${item.score}</strong>
          <span>${fmtClock(new Date(item.candleTime))}</span>
        </div>
      </div>`,
    )
    .join("");
}

/* ------------------------------------------------------------------ *
 * Banner / countdown
 * ------------------------------------------------------------------ */

function showBanner(kind, message) {
  const banner = $("scan-banner");
  banner.className = `scan-banner ${kind}`;
  banner.textContent = message;
  banner.hidden = false;
}

function hideBanner() {
  $("scan-banner").hidden = true;
}

const REFRESH_MS = 10000;

async function refreshLiveData() {
  if (state.scanning || state.refreshing) return;
  state.refreshing = true;
  try {
    if (state.market.length) {
      const symbolsParam = encodeURIComponent(
        JSON.stringify(state.market.map((item) => item.symbol)),
      );
      const tickers = await api(`/api/v3/ticker/24hr?symbols=${symbolsParam}`, {
        timeout: 12000,
      });
      const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
      state.market = state.market
        .map((item) => {
          const ticker = tickerMap.get(item.symbol);
          if (!ticker) return item;
          return {
            ...item,
            price: Number(ticker.lastPrice) || item.price,
            change: Number(ticker.priceChangePercent) || 0,
            volume: Number(ticker.quoteVolume) || item.volume,
          };
        })
        .sort((a, b) => b.volume - a.volume);
      renderMarket();
      renderStats();
      updateChartPrice();
      highlightSelection();
    }
    await loadPairData(state.selectedSymbol);
  } catch {
    /* keep the last known values */
  } finally {
    state.refreshing = false;
  }
}

function tick() {
  const now = Date.now();

  if (state.nextScanAt && now >= state.nextScanAt.getTime() && !state.scanning) {
    scan();
  }

  if (!state.refreshAt) state.refreshAt = now + REFRESH_MS;
  const remaining = Math.max(0, state.refreshAt - now);
  const seconds = Math.ceil(remaining / 1000);
  $("countdown").textContent = `${String(seconds).padStart(2, "0")}s`;
  $("scan-progress-bar").style.width = `${((REFRESH_MS - remaining) / REFRESH_MS) * 100}%`;

  updateTicketCountdown();

  if (remaining <= 0) {
    state.refreshAt = now + REFRESH_MS;
    refreshLiveData();
  }
}

function startClock() {
  clearInterval(state.timer);
  state.refreshAt = Date.now() + REFRESH_MS;
  tick();
  state.timer = setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ *
 * Backtest
 * ------------------------------------------------------------------ */

async function runBacktest(symbol = state.selectedSymbol, { force = false } = {}) {
  if (!symbol) return;
  if (
    !force &&
    state.backtestSymbol === symbol &&
    state.backtest &&
    Date.now() - state.backtestAt < 10 * 60 * 1000
  ) {
    renderBacktest();
    return;
  }

  state.backtestLoading = true;
  $("backtest-pair").textContent = symbol;
  $("backtest-accuracy").textContent = "…";
  const ring = $("backtest-ring");
  ring.setAttribute("stroke-dashoffset", "326.7");
  ring.classList.remove("warn", "bad");
  $("backtest-verdict").textContent = "Reading the last ~3 days of 5m candles…";
  $("backtest-stats").innerHTML = "";
  $("backtest-note").textContent = "Loading historical candles from Binance.";

  try {
    const rows = await api(
      `/api/v3/klines?symbol=${symbol}&interval=5m&limit=1000`,
      { timeout: 20000 },
    );
    if (state.selectedSymbol !== symbol) return;
    state.backtest = backtest(closedCandles(rows), CONFIG, {
      maxHold: 48,
      warmup: 60,
      symbol,
    });
    state.backtestSymbol = symbol;
    state.backtestAt = Date.now();
    renderBacktest();
  } catch {
    if (state.selectedSymbol !== symbol) return;
    state.backtest = null;
    $("backtest-accuracy").textContent = "—";
    $("backtest-verdict").textContent = "Backtest unavailable";
    $("backtest-note").textContent = "Could not load historical candles from Binance.";
    $("backtest-stats").innerHTML = "";
  } finally {
    state.backtestLoading = false;
  }
}

function renderBacktest() {
  const result = state.backtest;
  $("backtest-pair").textContent = state.backtestSymbol || state.selectedSymbol;
  if (!result) {
    $("backtest-accuracy").textContent = "—";
    return;
  }

  const accuracy = Math.round(result.accuracy);
  const ring = $("backtest-ring");
  const circumference = 2 * Math.PI * 52;
  ring.setAttribute("stroke-dashoffset", String(circumference * (1 - accuracy / 100)));
  ring.classList.toggle("warn", accuracy < 60 && accuracy >= 45);
  ring.classList.toggle("bad", accuracy < 45);
  $("backtest-accuracy").textContent = String(accuracy);

  $("backtest-verdict").innerHTML = result.decided
    ? `<strong>${accuracy}/100</strong> — ${result.wins} of ${result.decided} completed setups reached the 1R target before the stop.`
    : "No completed setups in this sample window.";

  const profitFactor = Number.isFinite(result.profitFactor)
    ? result.profitFactor.toFixed(2)
    : "∞";
  const stats = [
    ["Trades", result.decided],
    ["Wins", result.wins],
    ["Losses", result.losses],
    ["Avg R", result.avgR.toFixed(2)],
    ["Profit factor", profitFactor],
    ["Max DD", `${result.maxDrawdown.toFixed(2)}R`],
  ];
  $("backtest-stats").innerHTML = stats
    .map(
      ([label, value]) =>
        `<div class="backtest-stat"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");

  $("backtest-note").textContent = `Sample: ${result.trades.length} setups from roughly the last 3 days of 5m candles. Entry at the next candle open, 1R target, signal stop, max hold 4h. Overlapping trades counted independently. Past performance does not predict future results.`;
}

/* ------------------------------------------------------------------ *
 * Trade ticket
 * ------------------------------------------------------------------ */

function loadTicketSettings() {
  try {
    const account = Number(localStorage.getItem("signalDesk.account"));
    const risk = Number(localStorage.getItem("signalDesk.risk"));
    if (Number.isFinite(account) && account >= 10) state.accountSize = account;
    if (Number.isFinite(risk) && risk > 0 && risk <= 10) state.riskPct = risk;
  } catch {
    /* defaults are fine */
  }
  $("calc-account").value = String(state.accountSize);
  $("calc-risk").value = String(state.riskPct);
}

function saveTicketSettings() {
  try {
    localStorage.setItem("signalDesk.account", String(state.accountSize));
    localStorage.setItem("signalDesk.risk", String(state.riskPct));
  } catch {
    /* storage is optional */
  }
}

function levelCard(label, value, sub, cls = "") {
  return `<div class="ticket-level ${cls}"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`;
}

function renderTicket() {
  const panel = $("ticket-panel");
  const symbol = state.selectedSymbol;
  const signal = state.signals.find((item) => item.symbol === symbol) || null;
  const snapshot = indicatorSnapshot(state.chartKlines, CONFIG);
  const side = $("ticket-side");
  const score = $("ticket-score");

  $("ticket-symbol").textContent = symbol;
  panel.classList.toggle("no-trade", !signal);

  if (signal) {
    side.hidden = false;
    side.className = `side-pill ${signal.side}`;
    side.textContent = signal.side.toUpperCase();
    score.textContent = `Score ${signal.score}/100`;
    $("ticket-setup").textContent = signal.setup;
  } else {
    side.hidden = true;
    score.textContent = snapshot ? "No trigger" : "Waiting";
    $("ticket-setup").textContent = snapshot
      ? "No qualifying setup on this pair right now. The checklist shows exactly what is missing."
      : "Reading the latest closed candles…";
  }

  renderTicketLevels(signal, snapshot);
  renderTicketTiming(signal, snapshot);
  renderTicketChecklist(signal, snapshot);
  renderTicketCalc(signal);
  updateTicketCountdown();
}

function renderTicketLevels(signal, snapshot) {
  const host = $("ticket-levels");
  if (!signal) {
    host.innerHTML = `
      ${levelCard("Last price", snapshot ? fmtPrice(snapshot.price) : "—", "Closed 5m candle")}
      ${levelCard("Support", snapshot ? fmtPrice(snapshot.support) : "—", "48-candle low")}
      ${levelCard("Resistance", snapshot ? fmtPrice(snapshot.resistance) : "—", "48-candle high")}
      ${levelCard("ATR 14", snapshot ? `${snapshot.atrPct.toFixed(2)}%` : "—", "Volatility")}`;
    return;
  }

  const risk = Math.abs(signal.entry - signal.stop);
  const tp1R = risk > 0 ? Math.abs(signal.takeProfit1 - signal.entry) / risk : 0;
  const tp2R = risk > 0 ? Math.abs(signal.takeProfit2 - signal.entry) / risk : 0;

  host.innerHTML = `
    ${levelCard("Entry", fmtPrice(signal.entry), "Signal candle close", "entry")}
    ${levelCard("Stop", fmtPrice(signal.stop), `${((risk / signal.entry) * 100).toFixed(2)}% risk`, "stop")}
    ${levelCard("Target 1", fmtPrice(signal.takeProfit1), `${tp1R.toFixed(1)}R`, "tp")}
    ${levelCard("Target 2", fmtPrice(signal.takeProfit2), `${tp2R.toFixed(1)}R`, "tp")}`;
}

function renderTicketTiming(signal, snapshot) {
  const timeframe = $("ticket-timeframe");
  const trigger = $("ticket-trigger");

  if (!signal) {
    timeframe.textContent = "Wait for a 5m close";
    trigger.textContent = snapshot
      ? `No entry yet. Watch the next 5m close: it must clear resistance at ${fmtPrice(snapshot.resistance)} or reject support at ${fmtPrice(snapshot.support)}.`
      : "Waiting for closed candles before suggesting a trigger.";
    return;
  }

  timeframe.textContent = "5-minute close";
  if (signal.setup === "Resistance breakout") {
    trigger.textContent = `Confirmed by the 5m close above ${fmtPrice(
      signal.resistance,
    )}. Aggressive: enter at the next candle open. Conservative: wait for a 1m retest that holds ${fmtPrice(
      signal.resistance,
    )}.`;
  } else if (signal.setup === "Support rejection") {
    trigger.textContent = `Confirmed by the 5m bullish rejection close above ${fmtPrice(
      signal.support,
    )}. Conservative: wait for a 1m higher low above ${fmtPrice(signal.support)}.`;
  } else {
    trigger.textContent =
      "Confirmed on the closed 5m signal candle. Use the 1m chart only to refine the fill, not to invent a setup.";
  }
}

function renderTicketChecklist(signal, snapshot) {
  const host = $("ticket-checklist");
  if (!snapshot) {
    host.innerHTML = `<li><span class="check-icon fail">…</span><span>Waiting for candle data.</span></li>`;
    return;
  }

  const structurePass = signal
    ? true
    : snapshot.price > snapshot.resistance ||
      (snapshot.candleLow <= snapshot.support + 0.35 * snapshot.atr &&
        snapshot.candleClose > snapshot.support &&
        snapshot.candleClose > snapshot.candleOpen);

  const checks = [
    ["EMA 20 above EMA 50", snapshot.trend === "up"],
    [
      `Volume ≥ ${snapshot.minVolumeRatio.toFixed(1)}× average`,
      snapshot.volumeRatio != null && snapshot.volumeRatio >= snapshot.minVolumeRatio,
    ],
    ["RSI inside the 50–72 band", snapshot.rsi >= 50 && snapshot.rsi <= 72],
    [
      `ATR inside ${snapshot.minAtrPct.toFixed(2)}–${snapshot.maxAtrPct.toFixed(2)}%`,
      snapshot.atrPct >= snapshot.minAtrPct && snapshot.atrPct <= snapshot.maxAtrPct,
    ],
    ["Structure trigger confirmed", structurePass],
    [`Confluence score ≥ ${snapshot.minScore}`, Boolean(signal)],
  ];

  host.innerHTML = checks
    .map(
      ([label, pass]) =>
        `<li><span class="check-icon ${pass ? "pass" : "fail"}">${pass ? "✓" : "✕"}</span><span>${label}</span></li>`,
    )
    .join("");
}

function renderTicketCalc(signal) {
  const out = $("calc-out");
  const riskAmount = (state.accountSize * state.riskPct) / 100;

  if (!signal) {
    out.innerHTML = `
      <div><span>Risk budget</span><strong>${fmtMoney(riskAmount)}</strong></div>
      <div><span>Plan</span><strong>No trade</strong></div>`;
    return;
  }

  const stopDistance = Math.abs(signal.entry - signal.stop);
  const units = stopDistance > 0 ? riskAmount / stopDistance : 0;
  const notional = units * signal.entry;
  const tp1Profit = units * Math.abs(signal.takeProfit1 - signal.entry);
  const tp2Profit = units * Math.abs(signal.takeProfit2 - signal.entry);
  const base = signal.symbol.replace("USDT", "");

  out.innerHTML = `
    <div><span>Risk budget</span><strong>${fmtMoney(riskAmount)}</strong></div>
    <div><span>Position size</span><strong>${fmtQty(units)} ${base}</strong></div>
    <div><span>Notional</span><strong>${fmtMoney(notional)}</strong></div>
    <div><span>Max loss</span><strong class="down">−${fmtMoney(riskAmount)}</strong></div>
    <div><span>TP1 profit</span><strong class="up">+${fmtMoney(tp1Profit)}</strong></div>
    <div><span>TP2 profit</span><strong class="up">+${fmtMoney(tp2Profit)}</strong></div>`;
}

function updateTicketCountdown() {
  const node = $("ticket-countdown");
  if (!node) return;
  const now = Date.now();
  const remaining = Math.max(0, nextBoundary(new Date(now)).getTime() - now);
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  node.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function ticketPlanText() {
  const signal = state.signals.find((item) => item.symbol === state.selectedSymbol);
  if (!signal) return null;
  const riskAmount = (state.accountSize * state.riskPct) / 100;
  const stopDistance = Math.abs(signal.entry - signal.stop);
  const units = stopDistance > 0 ? riskAmount / stopDistance : 0;
  const base = signal.symbol.replace("USDT", "");

  return [
    `${signal.symbol} · ${signal.side.toUpperCase()} · ${signal.setup}`,
    "Suggested entry timeframe: 5m close",
    `Entry: ${fmtPrice(signal.entry)}`,
    `Stop: ${fmtPrice(signal.stop)}`,
    `Target 1R: ${fmtPrice(signal.takeProfit1)}`,
    `Target 2R: ${fmtPrice(signal.takeProfit2)}`,
    `Score: ${signal.score}/100`,
    `Position: ${fmtQty(units)} ${base} (${fmtMoney(units * signal.entry)} notional)`,
    `Risk: ${fmtMoney(riskAmount)} (${state.riskPct}% of ${fmtMoney(state.accountSize)})`,
    "Trigger: wait for the 5m close; use the 1m chart only to refine the fill.",
    `Signal candle: ${new Date(signal.candleTime).toISOString()}`,
    "Signal-only research. Not financial advice.",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    loginError.textContent = "Enter both your username and password.";
    return;
  }

  const lockedUntil = Number(sessionStorage.getItem("signalDesk.lockUntil")) || 0;
  if (Date.now() < lockedUntil) {
    loginError.textContent = `Too many attempts. Try again in ${Math.ceil(
      (lockedUntil - Date.now()) / 1000,
    )}s.`;
    return;
  }

  if (!crypto?.subtle) {
    loginError.textContent = "Open this page over https or localhost to sign in.";
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.querySelector("span").textContent = "Checking…";

  try {
    const digest = await sha256Hex(`${username}:${password}`);
    if (digest !== ACCESS_DIGEST) {
      const attempts = (Number(sessionStorage.getItem("signalDesk.attempts")) || 0) + 1;
      if (attempts >= 5) {
        sessionStorage.setItem("signalDesk.lockUntil", String(Date.now() + 60000));
        sessionStorage.setItem("signalDesk.attempts", "0");
        loginError.textContent = "Too many attempts. Locked for 60 seconds.";
      } else {
        sessionStorage.setItem("signalDesk.attempts", String(attempts));
        loginError.textContent = "Those credentials were not recognised.";
      }
      loginForm.classList.remove("shake");
      void loginForm.offsetWidth;
      loginForm.classList.add("shake");
      passwordInput.value = "";
      passwordInput.focus();
      return;
    }
    sessionStorage.removeItem("signalDesk.attempts");
    sessionStorage.removeItem("signalDesk.lockUntil");
    sessionStorage.setItem(SESSION_KEY, "1");
    enterDesk();
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.querySelector("span").textContent = "Enter desk";
  }
});

togglePassword.addEventListener("click", () => {
  const visible = passwordInput.type === "text";
  passwordInput.type = visible ? "password" : "text";
  togglePassword.classList.toggle("is-visible", !visible);
  togglePassword.setAttribute("aria-label", visible ? "Show password" : "Hide password");
});

$("refresh-btn").addEventListener("click", () => scan());

$("news-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-window]");
  if (!button) return;
  state.newsWindow = button.dataset.window;
  document.querySelectorAll(".news-tab").forEach((node) => {
    const active = node === button;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-selected", String(active));
  });
  renderNews();
});

$("backtest-run").addEventListener("click", () => {
  runBacktest(state.selectedSymbol, { force: true });
});

$("ticket-copy").addEventListener("click", async () => {
  const text = ticketPlanText();
  if (!text) {
    showToast("No qualifying setup to copy on this pair.", true);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast("Trade plan copied.");
  } catch {
    showToast("Clipboard access was blocked by the browser.", true);
  }
});

$("ticket-chart").addEventListener("click", () => {
  document
    .querySelector(".chart-panel")
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
});

function applyCalcSettings() {
  const account = Number($("calc-account").value);
  const risk = Number($("calc-risk").value);
  if (Number.isFinite(account) && account >= 10) state.accountSize = account;
  if (Number.isFinite(risk) && risk > 0 && risk <= 10) state.riskPct = risk;
  saveTicketSettings();
  renderTicketCalc(state.signals.find((item) => item.symbol === state.selectedSymbol) || null);
}

$("calc-account").addEventListener("input", applyCalcSettings);
$("calc-risk").addEventListener("input", applyCalcSettings);

$("logout-btn").addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  appView.hidden = true;
  loginView.hidden = false;
  clearInterval(state.timer);
  clearTimeout(state.chartTimer);
  clearTimeout(state.liveRenderTimer);
  state.timer = null;
  disconnectLive();
  passwordInput.value = "";
  usernameInput.value = "";
  loginError.textContent = "";
  window.scrollTo({ top: 0, behavior: "auto" });
});

$("clear-history").addEventListener("click", () => {
  state.history = [];
  saveHistory();
  renderHistory();
  showToast("Session history cleared.");
});

document.addEventListener("click", async (event) => {
  const scanButton = event.target.closest(".js-scan");
  if (scanButton) {
    scan();
    return;
  }

  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    const symbol = copyButton.dataset.copy;
    const signal = state.signals.find((s) => s.symbol === symbol);
    if (!signal) return;

    const text = [
      `${signal.symbol} · ${signal.side.toUpperCase()} · ${signal.setup}`,
      `Score: ${signal.score}/100`,
      `Suggested entry timeframe: 5m close`,
      `Entry: ${fmtPrice(signal.entry)}`,
      `Stop: ${fmtPrice(signal.stop)}`,
      `Target 1R: ${fmtPrice(signal.takeProfit1)}`,
      `Target 2R: ${fmtPrice(signal.takeProfit2)}`,
      `ATR: ${((signal.atr / signal.entry) * 100).toFixed(2)}% · RSI: ${signal.rsi.toFixed(1)} · Volume: ${signal.volumeRatio.toFixed(2)}x`,
      `Closed candle: ${new Date(signal.candleTime).toISOString()}`,
      "Signal-only research. Not financial advice.",
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      copyButton.classList.add("copied");
      copyButton.querySelector("span").textContent = "Copied";
      setTimeout(() => {
        copyButton.classList.remove("copied");
        copyButton.querySelector("span").textContent = "Copy setup";
      }, 1800);
    } catch {
      showToast("Clipboard access was blocked by the browser.", true);
    }
    return;
  }

  const selectable = event.target.closest("[data-symbol]");
  if (selectable) selectSymbol(selectable.dataset.symbol);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const target = event.target.closest?.("[data-symbol]");
  if (!target || event.target.closest("button, a, input")) return;
  event.preventDefault();
  selectSymbol(target.dataset.symbol);
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function enterDesk() {
  loginView.hidden = true;
  appView.hidden = false;
  loadHistory();
  loadTicketSettings();
  renderHistory();
  renderStats();
  renderStatus();
  renderIndicators();
  renderTicket();
  renderChart();
  connectLive(state.selectedSymbol);
  loadPairData(state.selectedSymbol);
  runBacktest(state.selectedSymbol);
  startClock();
  scan();
}

loadHistory();
if (sessionStorage.getItem(SESSION_KEY) === "1") {
  enterDesk();
} else {
  usernameInput.focus();
}
