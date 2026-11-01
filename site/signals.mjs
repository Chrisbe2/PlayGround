export const CONFIG = Object.freeze({
  minQuoteVolume: 10_000_000,
  maxSymbols: 24,
  klineLimit: 180,
  atrPeriod: 14,
  rsiPeriod: 14,
  volumePeriod: 20,
  srLookback: 48,
  minVolumeRatio: 1.5,
  minAtrPct: 0.0005,
  maxAtrPct: 0.03,
  minScore: 70,
  stopAtrMultiple: 1.5,
  allowShorts: false,
});

const EXCLUDED_BASES = new Set([
  "USDC", "FDUSD", "TUSD", "USDP", "DAI", "USD1", "AEUR", "EURI",
]);

export function parseKlines(rows) {
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
  }));
}

export function closedCandles(rows, now = Date.now()) {
  return parseKlines(rows).filter((candle) => candle.closeTime <= now);
}

export function selectCandidates(exchangeInfo, tickers, config = CONFIG) {
  const volumes = new Map(
    tickers.map((ticker) => [ticker.symbol, Number(ticker.quoteVolume) || 0]),
  );
  const candidates = [];
  for (const item of exchangeInfo.symbols || []) {
    const symbol = item.symbol || "";
    const base = item.baseAsset || "";
    if (item.status !== "TRADING" || item.quoteAsset !== "USDT") continue;
    if (item.isSpotTradingAllowed === false) continue;
    if (EXCLUDED_BASES.has(base)) continue;
    if (base.length > 3 && /(UP|DOWN|BULL|BEAR)$/.test(base)) continue;
    const volume = volumes.get(symbol) || 0;
    if (volume >= config.minQuoteVolume) candidates.push({ symbol, volume });
  }
  candidates.sort((a, b) => b.volume - a.volume);
  return candidates.slice(0, config.maxSymbols).map((item) => item.symbol);
}

export function ema(values, period) {
  const result = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return result;
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  const multiplier = 2 / (period + 1);
  for (let index = period; index < values.length; index += 1) {
    current = (values[index] - current) * multiplier + current;
    result[index] = current;
  }
  return result;
}

export function atr(candles, period = 14) {
  const result = new Array(candles.length).fill(null);
  if (period <= 0 || candles.length < period) return result;
  const trueRanges = candles.map((candle, index) => {
    if (index === 0) return candle.high - candle.low;
    const previousClose = candles[index - 1].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  let current = trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  for (let index = period; index < candles.length; index += 1) {
    current = ((period - 1) * current + trueRanges[index]) / period;
    result[index] = current;
  }
  return result;
}

export function rsi(values, period = 14) {
  const result = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return result;
  const gains = [];
  const losses = [];
  for (let index = 1; index < values.length; index += 1) {
    const difference = values[index] - values[index - 1];
    gains.push(Math.max(difference, 0));
    losses.push(Math.max(-difference, 0));
  }
  let averageGain = gains.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  let averageLoss = losses.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  const calculate = (gain, loss) => {
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    if (gain === 0) return 0;
    return 100 - 100 / (1 + gain / loss);
  };

  result[period] = calculate(averageGain, averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    averageGain = ((period - 1) * averageGain + gains[index - 1]) / period;
    averageLoss = ((period - 1) * averageLoss + losses[index - 1]) / period;
    result[index] = calculate(averageGain, averageLoss);
  }
  return result;
}

function finishSignal({
  symbol,
  side,
  setup,
  candle,
  stopAnchor,
  currentAtr,
  currentRsi,
  volumeRatio,
  support,
  resistance,
  score,
  reasons,
  config,
}) {
  const entry = candle.close;
  const initialRisk = config.stopAtrMultiple * currentAtr;
  let stop;
  let takeProfit1;
  let takeProfit2;
  let risk;
  if (side === "long") {
    stop = Math.min(entry - initialRisk, stopAnchor);
    risk = entry - stop;
    takeProfit1 = entry + risk;
    takeProfit2 = entry + 2 * risk;
  } else {
    stop = Math.max(entry + initialRisk, stopAnchor);
    risk = stop - entry;
    takeProfit1 = entry - risk;
    takeProfit2 = entry - 2 * risk;
  }
  if (risk <= 0 || risk > 3.5 * currentAtr || takeProfit1 <= 0) return null;
  return {
    symbol,
    side,
    setup,
    candleTime: candle.closeTime,
    entry,
    stop,
    takeProfit1,
    takeProfit2,
    atr: currentAtr,
    rsi: currentRsi,
    volumeRatio,
    support,
    resistance,
    score: Math.min(100, Math.round(score)),
    reasons,
  };
}

export function evaluateSymbol(symbol, candles, config = CONFIG) {
  const minimum = Math.max(60, config.srLookback + 2, config.volumePeriod + 2);
  if (candles.length < minimum) return null;

  const closes = candles.map((candle) => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atrValues = atr(candles, config.atrPeriod);
  const rsiValues = rsi(closes, config.rsiPeriod);
  const currentAtr = atrValues.at(-1);
  const currentRsi = rsiValues.at(-1);
  const fast = ema20.at(-1);
  const slow = ema50.at(-1);
  if ([currentAtr, currentRsi, fast, slow].some((value) => value === null)) return null;

  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (current.close <= 0 || currentAtr <= 0) return null;
  const atrPct = currentAtr / current.close;
  if (atrPct < config.minAtrPct || atrPct > config.maxAtrPct) return null;

  const volumeWindow = candles.slice(-config.volumePeriod - 1, -1);
  const averageVolume =
    volumeWindow.reduce((sum, candle) => sum + candle.volume, 0) / volumeWindow.length;
  if (averageVolume <= 0) return null;
  const volumeRatio = current.volume / averageVolume;

  const structureWindow = candles.slice(-config.srLookback - 1, -1);
  const support = Math.min(...structureWindow.map((candle) => candle.low));
  const resistance = Math.max(...structureWindow.map((candle) => candle.high));
  const trendUp = fast > slow;
  const trendDown = fast < slow;
  const trendStrength = Math.abs(fast - slow) / currentAtr;
  const candidates = [];

  const score = (base) =>
    base +
    Math.min(12, Math.max(0, (volumeRatio - 1) * 8)) +
    Math.min(8, trendStrength * 4);

  if (
    trendUp &&
    previous.close <= resistance &&
    resistance < current.close &&
    current.close - resistance <= currentAtr &&
    currentRsi >= 50 &&
    currentRsi <= 72 &&
    volumeRatio >= config.minVolumeRatio
  ) {
    const signal = finishSignal({
      symbol,
      side: "long",
      setup: "Resistance breakout",
      candle: current,
      stopAnchor: resistance - 0.15 * currentAtr,
      currentAtr,
      currentRsi,
      volumeRatio,
      support,
      resistance,
      score: score(72),
      reasons: [
        "Fresh close above prior resistance",
        "EMA20 is above EMA50",
        `Volume is ${volumeRatio.toFixed(2)}x its prior average`,
        "RSI confirms momentum without using an overbought extreme",
      ],
      config,
    });
    if (signal) candidates.push(signal);
  }

  const rejectionVolume = Math.max(1.2, config.minVolumeRatio * 0.8);
  const candleRange = current.high - current.low;
  const strongClose =
    candleRange > 0 && (current.close - current.low) / candleRange >= 0.65;
  if (
    trendUp &&
    current.low <= support + 0.35 * currentAtr &&
    current.close > support &&
    current.close > current.open &&
    strongClose &&
    currentRsi >= 40 &&
    currentRsi <= 65 &&
    volumeRatio >= rejectionVolume
  ) {
    const signal = finishSignal({
      symbol,
      side: "long",
      setup: "Support rejection",
      candle: current,
      stopAnchor: support - 0.15 * currentAtr,
      currentAtr,
      currentRsi,
      volumeRatio,
      support,
      resistance,
      score: score(68) + 3,
      reasons: [
        "Price rejected the prior support area and closed bullish",
        "EMA20 is above EMA50",
        `Volume is ${volumeRatio.toFixed(2)}x its prior average`,
        "Close is in the upper portion of the candle",
      ],
      config,
    });
    if (signal) candidates.push(signal);
  }

  if (config.allowShorts) {
    if (
      trendDown &&
      previous.close >= support &&
      support > current.close &&
      support - current.close <= currentAtr &&
      currentRsi >= 28 &&
      currentRsi <= 50 &&
      volumeRatio >= config.minVolumeRatio
    ) {
      const signal = finishSignal({
        symbol,
        side: "short",
        setup: "Support breakdown",
        candle: current,
        stopAnchor: support + 0.15 * currentAtr,
        currentAtr,
        currentRsi,
        volumeRatio,
        support,
        resistance,
        score: score(72),
        reasons: [
          "Fresh close below prior support",
          "EMA20 is below EMA50",
          `Volume is ${volumeRatio.toFixed(2)}x its prior average`,
          "RSI confirms bearish momentum without using an oversold extreme",
        ],
        config,
      });
      if (signal) candidates.push(signal);
    }

    const weakClose =
      candleRange > 0 && (current.high - current.close) / candleRange >= 0.65;
    if (
      trendDown &&
      current.high >= resistance - 0.35 * currentAtr &&
      current.close < resistance &&
      current.close < current.open &&
      weakClose &&
      currentRsi >= 35 &&
      currentRsi <= 60 &&
      volumeRatio >= rejectionVolume
    ) {
      const signal = finishSignal({
        symbol,
        side: "short",
        setup: "Resistance rejection",
        candle: current,
        stopAnchor: resistance + 0.15 * currentAtr,
        currentAtr,
        currentRsi,
        volumeRatio,
        support,
        resistance,
        score: score(68) + 3,
        reasons: [
          "Price rejected the prior resistance area and closed bearish",
          "EMA20 is below EMA50",
          `Volume is ${volumeRatio.toFixed(2)}x its prior average`,
          "Close is in the lower portion of the candle",
        ],
        config,
      });
      if (signal) candidates.push(signal);
    }
  }

  const qualifying = candidates.filter((signal) => signal.score >= config.minScore);
  return qualifying.sort((a, b) => b.score - a.score)[0] || null;
}

export function indicatorSnapshot(candles, config = CONFIG) {
  const minimum = Math.max(60, config.srLookback + 2, config.volumePeriod + 2);
  if (!candles || candles.length < minimum) return null;

  const closes = candles.map((candle) => candle.close);
  const fast = ema(closes, 20).at(-1);
  const slow = ema(closes, 50).at(-1);
  const currentAtr = atr(candles, config.atrPeriod).at(-1);
  const currentRsi = rsi(closes, config.rsiPeriod).at(-1);
  const current = candles.at(-1);
  if ([fast, slow, currentAtr, currentRsi].some((value) => value === null)) return null;
  if (current.close <= 0) return null;

  const volumeWindow = candles.slice(-config.volumePeriod - 1, -1);
  const averageVolume =
    volumeWindow.reduce((sum, candle) => sum + candle.volume, 0) / volumeWindow.length;
  const volumeRatio = averageVolume > 0 ? current.volume / averageVolume : null;

  const structureWindow = candles.slice(-config.srLookback - 1, -1);
  const support = Math.min(...structureWindow.map((candle) => candle.low));
  const resistance = Math.max(...structureWindow.map((candle) => candle.high));

  const range = current.high - current.low;
  const closePosition = range > 0 ? (current.close - current.low) / range : 0.5;

  return {
    price: current.close,
    ema20: fast,
    ema50: slow,
    trend: fast > slow ? "up" : fast < slow ? "down" : "flat",
    trendSpreadPct: ((fast - slow) / current.close) * 100,
    atr: currentAtr,
    atrPct: (currentAtr / current.close) * 100,
    rsi: currentRsi,
    volumeRatio,
    averageVolume,
    currentVolume: current.volume,
    support,
    resistance,
    closePosition,
    candleOpen: current.open,
    candleHigh: current.high,
    candleLow: current.low,
    candleClose: current.close,
    srLookback: config.srLookback,
    volumePeriod: config.volumePeriod,
    minVolumeRatio: config.minVolumeRatio,
    minAtrPct: config.minAtrPct * 100,
    maxAtrPct: config.maxAtrPct * 100,
    minScore: config.minScore,
  };
}

export function backtest(candles, config = CONFIG, options = {}) {
  const maxHold = options.maxHold ?? 48;
  const warmup = options.warmup ?? 60;
  const symbol = options.symbol || "PAIR";
  const trades = [];
  const empty = {
    trades,
    wins: 0,
    losses: 0,
    timeouts: 0,
    decided: 0,
    accuracy: 0,
    totalR: 0,
    avgR: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    curve: [],
  };
  if (!candles || candles.length < warmup + maxHold + 2) return empty;

  for (let index = warmup; index < candles.length - 1; index += 1) {
    const signal = evaluateSymbol(symbol, candles.slice(0, index + 1), config);
    if (!signal) continue;

    const entryCandle = candles[index + 1];
    const entry = entryCandle.open;
    if (!Number.isFinite(entry) || entry <= 0) continue;

    const risk = Math.abs(signal.entry - signal.stop);
    const reward = Math.abs(signal.takeProfit1 - signal.entry);
    if (!(risk > 0) || !(reward > 0)) continue;

    const isLong = signal.side === "long";
    const stop = isLong ? entry - risk : entry + risk;
    const target = isLong ? entry + reward : entry - reward;
    if (target <= 0) continue;

    let outcome = "timeout";
    let exitPrice = candles[Math.min(index + maxHold, candles.length - 1)].close;

    for (let cursor = index + 1; cursor < Math.min(index + 1 + maxHold, candles.length); cursor += 1) {
      const candle = candles[cursor];
      const hitStop = isLong ? candle.low <= stop : candle.high >= stop;
      const hitTarget = isLong ? candle.high >= target : candle.low <= target;

      if (hitStop && hitTarget) {
        outcome = "loss";
        exitPrice = stop;
        break;
      }
      if (hitStop) {
        outcome = "loss";
        exitPrice = stop;
        break;
      }
      if (hitTarget) {
        outcome = "win";
        exitPrice = target;
        break;
      }
    }

    const r = isLong ? (exitPrice - entry) / risk : (entry - exitPrice) / risk;
    trades.push({
      candleTime: signal.candleTime,
      side: signal.side,
      setup: signal.setup,
      score: signal.score,
      entry,
      stop,
      target,
      exitPrice,
      outcome,
      r: Number(r.toFixed(3)),
    });
  }

  const wins = trades.filter((trade) => trade.outcome === "win").length;
  const losses = trades.filter((trade) => trade.outcome === "loss").length;
  const timeouts = trades.filter((trade) => trade.outcome === "timeout").length;
  const decided = wins + losses + timeouts;
  const accuracy = decided > 0 ? (wins / decided) * 100 : 0;
  const totalR = trades.reduce((sum, trade) => sum + trade.r, 0);
  const grossWin = trades.filter((trade) => trade.r > 0).reduce((sum, trade) => sum + trade.r, 0);
  const grossLoss = Math.abs(
    trades.filter((trade) => trade.r < 0).reduce((sum, trade) => sum + trade.r, 0),
  );
  const profitFactor =
    grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Number.POSITIVE_INFINITY : 0;

  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const curve = [];
  for (const trade of trades) {
    equity += trade.r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    curve.push(Number(equity.toFixed(3)));
  }

  return {
    trades,
    wins,
    losses,
    timeouts,
    decided,
    accuracy,
    totalR,
    avgR: trades.length ? totalR / trades.length : 0,
    profitFactor,
    maxDrawdown,
    curve,
  };
}

export function btcRegime(candles) {
  if (candles.length < 60) return null;
  const closes = candles.map((candle) => candle.close);
  const fast = ema(closes, 20).at(-1);
  const slow = ema(closes, 50).at(-1);
  const momentum = rsi(closes, 14).at(-1);
  if (fast === null || slow === null || momentum === null) return null;
  return {
    price: closes.at(-1),
    trend: fast > slow ? "Bullish" : "Bearish",
    ema20: fast,
    ema50: slow,
    rsi: momentum,
  };
}
