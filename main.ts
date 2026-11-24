// Sprint Rider — pump.fun 6h replay bot.
//
// What the dev-window data actually says (after fixing two backtest bugs
// that made earlier versions look better than they were: exits must be
// scored at the 2-slots-later FILL price, not the decision price, and every
// trigger must be counted, not just the coins that kept trading):
//
//   - Buying early momentum loses ~6-9% per trade after fees on this
//     window, under every filter tried (momentum, buy pressure, dips,
//     breakouts, spray). The median coin ends -8%; most spikes retrace
//     before a take-profit can fill.
//   - The ONE rule that came out positive is the completion rider: coins
//     whose real SOL reserves cross 50 (on the way to ~85 at completion;
//     42% of them complete) keep climbing often enough that TP +30% /
//     SL -10% averages +4.0% per trade (n=26). It is a small sample, so
//     it is sized modestly (0.10 SOL a coin).
//   - Every other entry in this bounty loses money the same way, so the
//     winning play is to lose as little as possible while meeting the
//     guardrails (a round trip of >= 0.01 SOL on >= 20 coins, drawdown
//     <= 50%): ride the completion candidates at real size, and fill the
//     coin quota with minimum-size early-momentum trades whose expected
//     cost is ~0.025 SOL total.
//
//   Rider: a coin whose real reserves reach >= 50 SOL and whose price is
//     not falling over its last 3 batch observations. Size 0.10 SOL
//     (cap: 1% of real reserves, so >= 0.50 SOL is allowed here — 0.10
//     keeps the bot's own price impact small). Exit at +30% take-profit,
//     -10% stop-loss, or after 200 batch observations with no exit.
//     Exits are measured against the DECISION-TIME price, not the
//     fee-loaded cost basis: the backtest's TP/SL are price changes, and
//     measuring against cost (fees included) silently tightens the stop
//     from -10% to about -7%, which the backtest shows costs ~2% a trade.
//   Filler: the early-momentum rule (coin <= 15 observations, price up
//     >= 15% over its last 3 observations, >= 4 buys among its last 5
//     batches' trades), size 0.01 SOL — the guardrail minimum. Only
//     until 30 distinct coins have been traded in total, then it stops.
//
// v8 changes vs v7 (which graded -0.103 SOL): exits now compare the live
// price to the decision-time reference price instead of the fee-loaded
// cost, and the rider stop widens to -10% (the backtest's best rider
// spread: TP +30% / SL -10% averages +4.0% a trade, vs +3.3% at -8%).
//   One trade per mint; at most 5 open positions (harness cap).
//   Fees: ~0.95% protocol + ~0.30% creator on each leg, plus 105,000
//     lamports of tx fees per order.
//
// Determinism: every decision comes from the harness state alone (hello,
// batch, orders, slot). No clock, no environment, no Math.random — the
// two graded executions produce identical action logs.
import { runBot } from "./vendor/makefun-bot.ts";
import type { Batch, BotState } from "./vendor/makefun-bot.ts";

// --- rider (completion candidates) -----------------------------------------
const RIDER_RQ_MIN_LAMPORTS = 50_000_000_000n; // 50 SOL of real reserves
const RIDER_SIZE_LAMPORTS = 100_000_000n; // 0.10 SOL per coin
const RIDER_TP_BPS = 3000; // +30% vs the decision-time price
const RIDER_SL_BPS = 1000; // -10% vs the decision-time price
const RIDER_HOLD_OBS = 200; // sell after this many observations with no exit
const RIDER_MOM_WINDOW = 3; // momentum measured over this many observations
const RIDER_MOM_MIN_BPS = 0; // ... and must not be falling

// --- filler (guardrail quota, minimum size) --------------------------------
const FILLER_SIZE_LAMPORTS = 10_000_000n; // 0.01 SOL per coin
const FILLER_MAX_COINS = 30; // stop filler entries after this many coins traded
const FILLER_MIN_OBS = 5;
const FILLER_MAX_OBS = 15;
const FILLER_MOM_WINDOW = 3;
const FILLER_MOM_MIN_BPS = 1500; // +15% over the window
const FILLER_BUY_WINDOW = 5; // last N observations checked for buy pressure
const FILLER_BUY_MIN = 4; // at least this many buys among them
const FILLER_TP_BPS = 5000; // +50% vs the decision-time price
const FILLER_SL_BPS = 1000; // -10% vs the decision-time price
const FILLER_HOLD_OBS = 80;

// --- shared -----------------------------------------------------------------
const MIN_REAL_RESERVE_LAMPORTS = 1_000_000_000n; // 1 SOL real reserves
const TIME_STOP_SLOTS = 12000; // backstop only (~80 min)
const SLIPPAGE_BPS = 10000; // accept any fill: a tight cap rejects exactly
// the buys on coins still pumping (price moved > cap in the 2-slot latency)
// and the sells on coins still crashing — adverse selection on both legs.
const CASH_BUFFER_LAMPORTS = 10_000_000n; // keep 0.01 SOL spare for fees
const PRICE_HISTORY = 12; // recent observation prices kept per mint
const BUY_HISTORY = 5; // recent observation buy-counts kept per mint

interface CoinTrack {
  prices: number[]; // one post-batch price per batch with trades, oldest first
  obsBuys: number[]; // buys among the trades of each of those batches
  obs: number; // total batches with trades seen (uncapped, unlike prices)
}

interface ExitPlan {
  tpBps: number;
  slBps: number;
  maxHoldObs: number;
  refPrice: number; // price (lamports per base unit) when the buy was decided
}

interface PositionTrack extends ExitPlan {
  firstSeenSlot: number;
  entryObs: number; // observations seen when the position was first seen
}

const tracks = new Map<string, CoinTrack>();
const held = new Map<string, PositionTrack>();
const pendingBuy = new Map<string, ExitPlan>();
const traded = new Set<string>();

function priceOf(state: BotState, mint: string): number | null {
  const c = state.curves.get(mint);
  if (!c || c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

function markBps(state: BotState, mint: string, refPrice: number): number | null {
  const p = priceOf(state, mint);
  if (p === null || refPrice <= 0) return null;
  return Math.round(((p - refPrice) / refPrice) * 10000);
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const buys: { side: "buy"; mint: string; quote_lamports: bigint; max_slippage_bps: number }[] = [];
    const sells: { side: "sell"; mint: string; token_amount: bigint; max_slippage_bps: number }[] = [];

    // A buy that came back rejected/failed leaves no position: forget its
    // exit plan (the mint stays in `traded` — one shot per mint).
    for (const f of batch.fills) {
      if (f.side === "buy" && f.status !== "filled") pendingBuy.delete(f.mint);
    }

    // Fold this batch's trades into the per-coin price history: one entry
    // per batch WITH trades on the mint, priced from the curve's post-batch
    // reserves (the granularity the harness decides at — per-trade prices
    // fire the momentum trigger on intra-slot noise the backtest never
    // saw). obsBuys counts the buys among that batch's trades on the mint.
    const obsBuysThisBatch = new Map<string, number>();
    const seenThisBatch = new Set<string>();
    for (const e of batch.events) {
      if (e.event !== "TradeEvent") continue;
      seenThisBatch.add(e.mint);
      if (e.is_buy) {
        obsBuysThisBatch.set(e.mint, (obsBuysThisBatch.get(e.mint) ?? 0) + 1);
      }
    }
    for (const mint of seenThisBatch) {
      const p = priceOf(state, mint);
      if (p === null) continue;
      let t = tracks.get(mint);
      if (!t) {
        t = { prices: [], obsBuys: [], obs: 0 };
        tracks.set(mint, t);
      }
      t.prices.push(p);
      t.obsBuys.push(obsBuysThisBatch.get(mint) ?? 0);
      t.obs += 1;
      if (t.prices.length > PRICE_HISTORY) t.prices.shift();
      if (t.obsBuys.length > BUY_HISTORY) t.obsBuys.shift();
    }

    // --- exits first: each position follows the plan set at its entry -----
    for (const [mint, pos] of state.positions) {
      const track = held.get(mint);
      if (!track) {
        const plan = pendingBuy.get(mint) ?? {
          tpBps: FILLER_TP_BPS,
          slBps: FILLER_SL_BPS,
          maxHoldObs: FILLER_HOLD_OBS,
          refPrice: priceOf(state, mint) ?? 0,
        };
        pendingBuy.delete(mint);
        held.set(mint, {
          ...plan,
          firstSeenSlot: state.slot,
          entryObs: tracks.get(mint)?.obs ?? 0,
        });
        continue;
      }
      const bps = markBps(state, mint, track.refPrice);
      if (bps === null) continue;
      const timedOut = state.slot - track.firstSeenSlot > TIME_STOP_SLOTS;
      const obsNow = tracks.get(mint)?.obs ?? track.entryObs;
      const heldTooLong = obsNow - track.entryObs > track.maxHoldObs;
      if (bps >= track.tpBps || bps <= -track.slBps || heldTooLong || timedOut) {
        sells.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        held.delete(mint);
        traded.add(mint);
      }
    }

    // --- entries ------------------------------------------------------------
    const room = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (room > 0) {
      let bought = 0;
      for (const e of batch.events) {
        if (bought >= room) break;
        if (e.event !== "TradeEvent") continue;
        const mint = e.mint;
        if (traded.has(mint) || state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue;
        const t = tracks.get(mint);
        if (!t || t.prices.length <= RIDER_MOM_WINDOW) continue;
        const now = t.prices[t.prices.length - 1];
        const back = t.prices[t.prices.length - 1 - RIDER_MOM_WINDOW];
        if (back === undefined || back <= 0) continue;
        const momBps = Math.round(((now - back) / back) * 10000);

        // Rider: real reserves crossed 50 SOL and the price is not falling.
        const isRider =
          curve.real_quote_reserves >= RIDER_RQ_MIN_LAMPORTS &&
          momBps >= RIDER_MOM_MIN_BPS;
        // Filler: young coin, strong early momentum with buy pressure.
        const isFiller =
          traded.size < FILLER_MAX_COINS &&
          t.obs >= FILLER_MIN_OBS &&
          t.obs <= FILLER_MAX_OBS &&
          curve.real_quote_reserves >= MIN_REAL_RESERVE_LAMPORTS &&
          momBps >= FILLER_MOM_MIN_BPS &&
          t.obsBuys.slice(-FILLER_BUY_WINDOW).reduce((a, b) => a + b, 0) >= FILLER_BUY_MIN;
        if (!isRider && !isFiller) continue;

        const plan: ExitPlan = isRider
          ? { tpBps: RIDER_TP_BPS, slBps: RIDER_SL_BPS, maxHoldObs: RIDER_HOLD_OBS, refPrice: now }
          : { tpBps: FILLER_TP_BPS, slBps: FILLER_SL_BPS, maxHoldObs: FILLER_HOLD_OBS, refPrice: now };
        const want = isRider ? RIDER_SIZE_LAMPORTS : FILLER_SIZE_LAMPORTS;
        const cap = state.maxBuyLamports(mint);
        const free = state.freeCashLamports() - CASH_BUFFER_LAMPORTS;
        let size = want;
        if (size > cap) size = cap;
        if (size > free) size = free;
        if (size < FILLER_SIZE_LAMPORTS) continue;
        buys.push({
          side: "buy",
          mint,
          quote_lamports: size,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        pendingBuy.set(mint, plan);
        traded.add(mint);
        bought++;
      }
    }

    return [...sells, ...buys];
  },

  onDone(state: BotState) {
    console.error(
      `done: cash=${state.cash} positions=${state.positions.size} coinsTraded=${traded.size}`,
    );
  },
});
