# Crypto Scalping Signal Bot

A signal-only Python bot that scans liquid Binance spot USDT pairs on closed 5-minute candles. It combines support/resistance, ATR, volume, EMA trend, and RSI confirmation. Alerts can be printed locally or delivered to Telegram.

**It does not place orders and does not need exchange API keys.** No strategy guarantees profits. Start with observation or paper trading, include fees and slippage in your evaluation, and use a position size whose stop-loss loss you can afford.

## What the scanner does

1. Reads Binance public exchange information and 24-hour statistics.
2. Keeps active USDT spot pairs above the configured 24-hour quote-volume threshold, then selects the most liquid symbols. Stablecoin-to-stablecoin and leveraged-token pairs are excluded.
3. Downloads 5-minute candles and discards the still-forming candle.
4. Checks two long setups by default:
   - **Resistance breakout:** a fresh close above prior resistance, EMA20 above EMA50, RSI between 50 and 72, and above-average volume.
   - **Support rejection:** a bullish rejection near support, EMA20 above EMA50, a strong close, RSI between 40 and 65, and volume confirmation.
5. Rejects markets whose ATR percentage is outside the configured volatility band.
6. Calculates an ATR/structure-based stop and 1R/2R reference targets. It suppresses duplicate Telegram alerts during the cooldown.

Optional support-breakdown and resistance-rejection short signals can be enabled, but shorts are not ordinary spot trades. They may require derivatives or margin and involve additional risks, including liquidation and funding costs. The bot still will not trade.

## Project layout

```
bot.py                  CLI: --ping, --once, --loop, --test-telegram, --status
setup_telegram.py       One-command token validation, chat discovery, config
get_chat_id.py          Finds your numeric chat ID from getUpdates
review_signals.py       Replays journaled signals against later candles
scalping_bot/
  config.py             Environment parsing and validation
  binance.py            Public Binance client (no API keys)
  scanner.py            Symbol selection and scan loop
  strategy.py           Setup rules and confluence scoring
  indicators.py         EMA, ATR, and RSI
  models.py             Candle/Signal types and Telegram message text
  state.py              Persistent cooldown state
  journal.py            Append-only JSONL signal journal
  telegram.py           Chunked, retrying sendMessage delivery
  telegram_api.py       getMe/getUpdates helpers for setup
  logging_setup.py      UTC console and rotating-file logging
  review.py             Forward-test outcome evaluation
deploy/                 systemd unit and installer
tests/                  Offline unit tests
```

## Quick start

Requires Python 3.10 or newer.

```bash
cd crypto_scalping_signal_bot
python3 -m pip install -r requirements.txt
python3 bot.py --ping
python3 bot.py --once
```

Without Telegram credentials, qualifying alerts are printed locally. A scan with no alert means no setup passed every rule; it does not mean the bot is broken.

If `--ping` fails with HTTP 451 ("restricted location"), your network cannot use
`api.binance.com`. Use Binance's public market-data mirror instead:

```bash
export BINANCE_BASE_URL=https://data-api.binance.vision
python3 bot.py --ping
```

The mirror serves public candles and tickers only; it does not require keys and
does not place orders. Check that this service is permitted in your region.

## Telegram setup

Telegram has no API for creating bots. A human Telegram account must create the
bot in **@BotFather** once; after that, this project handles the linking.

### One-command setup (recommended)

1. Open the verified **@BotFather**, send `/newbot`, choose a name and username,
   and copy the token.
2. Run:

```bash
python3 setup_telegram.py
```

Paste the token when prompted; input is hidden. The script then:

- validates the token and prints your bot's `https://t.me/...` link,
- waits for you to press Start or send the bot a message,
- discovers your numeric chat ID,
- writes `config.env` with mode 600,
- sends a test message to confirm delivery.

If you have several chats, it lists them and uses the most recent private chat.
Rerun with `--chat-id <id>` to choose another. For a group, add the bot and send
a message there first (mention the bot, or disable privacy mode with BotFather
`/setprivacy`).

Then load the saved file and start scanning:

```bash
set -a; source config.env; set +a
python3 bot.py --status
python3 bot.py --loop
```

### Manual setup

1. Create the bot in **@BotFather** and copy its token.
2. Open your new bot and send it any message. A bot cannot initiate a chat with you.
3. Run `python3 get_chat_id.py` and paste the token when prompted. It prints the
   numeric chat ID for every chat that has messaged the bot.
4. Set credentials as environment variables. Do not paste them into source files
   or send them to anyone.

Linux/macOS:

```bash
export TELEGRAM_BOT_TOKEN='your_token'
export TELEGRAM_CHAT_ID='your_chat_id'
python3 bot.py --test-telegram
python3 bot.py --loop
```

Windows PowerShell:

```powershell
$env:TELEGRAM_BOT_TOKEN='your_token'
$env:TELEGRAM_CHAT_ID='your_chat_id'
python bot.py --test-telegram
python bot.py --loop
```

You can also copy `config.example.env` to `config.env`, fill it in, then load it on Linux/macOS:

```bash
set -a
source config.env
set +a
python3 bot.py --loop
```

Keep `config.env` private. The bot does not automatically load this file.

## Receiving signals

Work through these steps in order:

```bash
python3 bot.py --status          # 0. show config and recent journaled signals
python3 bot.py --test-telegram   # 1. proves token + chat ID + permissions
python3 bot.py --once            # 2. one real scan, alerts printed and sent
python3 bot.py --loop            # 3. continuous scanning every 5 minutes
```

`--status` prints the effective configuration, the newest journaled signals,
and how many cooldown keys are active. It never prints the bot token.

`--test-telegram` sends a fixed confirmation message. If that arrives, delivery
works; if it does not, fix the token or chat ID before running scans.

`--once` scans once and exits. Qualifying alerts are printed and, when Telegram
is configured, sent to your chat. `--loop` repeats the scan every
`SCAN_INTERVAL_SECONDS` (default 300). A bot can only message you after you have
started a conversation with it, so send it a message first.

A delivered alert contains the symbol, setup name, score, candle close time,
reference entry, stop, 1R/2R targets, ATR, RSI, volume ratio, support/resistance,
and the reasons the setup triggered. It never places an order.

No message usually means no symbol passed every rule, not that the bot is down.
The scanner prints `Scanned N pairs; found 0 qualifying setup(s).` in that case.
Raising `MIN_SIGNAL_SCORE` makes alerts rarer; lowering it makes them more
frequent. `SIGNAL_COOLDOWN_MINUTES` suppresses repeats of the same
symbol/side/setup pair.

For unattended use, run `--loop` under a process manager, tmux, or Docker so it
survives your terminal closing. Keep `state.json` between restarts so cooldowns
still apply. Every alert is also appended to `signals.jsonl`, and `LOG_FILE`
enables a rotating log in addition to the console.

## Configuration

| Environment variable | Default | Purpose |
|---|---:|---|
| `BINANCE_BASE_URL` | `https://api.binance.com` | Public Binance API base URL |
| `SIGNAL_INTERVAL` | `5m` | Candle interval; this version only permits 5m |
| `KLINE_LIMIT` | `180` | Candles downloaded per symbol |
| `MAX_SYMBOLS` | `40` | Maximum liquid pairs scanned per cycle |
| `MIN_24H_QUOTE_VOLUME` | `10000000` | Minimum 24h quote volume in USDT |
| `MIN_VOLUME_RATIO` | `1.5` | Breakout volume versus prior 20-candle average |
| `MIN_ATR_PCT` | `0.0005` | Minimum ATR/price (0.05%) |
| `MAX_ATR_PCT` | `0.03` | Maximum ATR/price (3%) |
| `MIN_SIGNAL_SCORE` | `70` | Minimum confluence score |
| `STOP_ATR_MULTIPLE` | `1.5` | Initial ATR risk distance |
| `SIGNAL_COOLDOWN_MINUTES` | `60` | Duplicate alert suppression |
| `SCAN_INTERVAL_SECONDS` | `300` | Delay between continuous scans |
| `ALLOW_SHORTS` | `false` | Enable short signal setups |
| `SIGNAL_STATE_FILE` | `state.json` | Local cooldown state |
| `SIGNAL_JOURNAL_FILE` | `signals.jsonl` | Append-only alert journal; empty disables |
| `LOG_FILE` | empty | Rotating log file; empty means console only |
| `REQUEST_PAUSE_SECONDS` | `0.12` | Pause between symbol requests |
| `REQUEST_TIMEOUT_SECONDS` | `15` | HTTP timeout for Binance and Telegram |

The score ranks confluence after a setup triggers. It is not a probability of winning. Entry, stop, and target values are references based on the signal candle's close, not executable quotes.

## Journal and forward testing

Every alert that is emitted (printed or sent) is appended to `signals.jsonl` as
one JSON object per line, including whether Telegram delivery succeeded. The
journal survives restarts and is the raw material for forward testing.

Replay journaled signals against later candles:

```bash
python3 review_signals.py
python3 review_signals.py --horizon 240 --since-days 7
python3 review_signals.py --symbol BTCUSDT --limit 20
python3 review_signals.py --json
```

The reviewer reports whether the stop, TP1, or TP2 was touched first, the R
multiple, and maximum favorable/adverse excursion in R. It follows each signal
for `--horizon` minutes (default 240) and prints a win rate and total R.

Read the output honestly:

- The reference entry is the signal candle's close, not a real fill.
- If a candle touches both the stop and a target, the stop is assumed first.
- Fees, spread, funding, and slippage are excluded.
- A small sample proves very little; aim for dozens of signals across different
  market conditions before drawing conclusions.

## Run unattended with systemd

The installer creates a dedicated state directory, installs a hardened unit, and
starts it:

```bash
sudo ./deploy/install-systemd.sh
```

On the first run it copies `config.example.env` to
`/etc/crypto-signal-bot.env` and stops. Edit that file with your token and chat
ID, then rerun the installer. State, journal, and logs go to
`/var/lib/crypto-signal-bot/`.

```bash
systemctl status crypto-signal-bot
journalctl -u crypto-signal-bot -f
sudo ./deploy/install-systemd.sh --dry-run   # inspect without changing anything
```

Options include `--user`, `--app-dir`, `--state-dir`, and `--env-file`. The unit
runs as your user, not root, and restricts write access to the state directory.
The installer prefers `APP_DIR/.venv/bin/python` when it exists, otherwise
`python3`; it checks that the selected interpreter can import `requests`.

## Docker

Copy the example environment file, fill it in, then start the service:

```bash
cp config.example.env config.env
mkdir -p state
docker compose up -d --build
docker compose logs -f
```

Compose persists `state/` and overrides the state, journal, and log paths to
`/app/state/`. To stop it, use `docker compose down`.

Without Compose:

```bash
docker build -t crypto-scalping-signal-bot .
docker run --restart unless-stopped \
  -e TELEGRAM_BOT_TOKEN='your_token' \
  -e TELEGRAM_CHAT_ID='your_chat_id' \
  -e SIGNAL_STATE_FILE=/app/state/state.json \
  -e SIGNAL_JOURNAL_FILE=/app/state/signals.jsonl \
  -e LOG_FILE=/app/state/bot.log \
  -v "$(pwd)/state:/app/state" \
  crypto-scalping-signal-bot
```

## Tests

```bash
python3 -m unittest discover -s tests -v
```

The test suite uses synthetic data and does not require network access or Telegram credentials.

## Operational notes

- Public API availability and Binance access vary by region. Use only services legally available to you and comply with their terms.
- Run `--ping` first. A network timeout or HTTP error must be fixed before live scanning.
- For continuous use, keep the process on a reliable machine and preserve the state, journal, and log files.
- A failed Telegram delivery is logged and does not abort the rest of the scan. It is retried on the next scan and journaled once delivery succeeds.
- Treat `config.env`, the bot token, and your chat ID as secrets. Revoke a leaked token with BotFather.
- Five-minute crypto signals are highly sensitive to spread, fees, slippage, latency, and false breakouts. A positive-looking backtest alone is not enough; forward-test before considering real money.
- This is research software, not personalized financial advice or a profit guarantee.
