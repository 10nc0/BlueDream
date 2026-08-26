---
name: Ψ-EMA weekly θ rolling-lag fix
description: Why weekly Phase θ must be computed from a rolling lag on daily closes, not from the last two week-bucketed candles.
---

Weekly θ (Phase) in `utils/psi-EMA.js` (`analyzePhase`) is NOT derived from the last two entries of the week-bucketed OHLC series by default anymore for the psi-ema dashboard's weekly call — it uses an explicit rolling lag against the daily closes series instead (`analyzePhase(prices, { lagPrices, lag })`, wired via `PsiEMADashboard.analyze({ stocks, phaseLagSeries, phaseLag })`).

**Why:** Yahoo's `1wk`-interval candles are calendar-week buckets (Monday-anchored). The newest bucket is often only 1-2 trading days old (e.g. right after a new week starts). A partial week's "close" equals that day's daily close, and the prior completed week's close equals its own last trading day — so on the first day(s) of a new week, comparing "latest week bucket vs previous week bucket" reduces to exactly "today vs yesterday," making weekly θ mathematically identical to daily θ. z (Anomaly) and R (Convergence) don't have this bug because they're derived from the full EMA-smoothed series, not just the last two points.

**How to apply:** Any dimension computed only from "last two points of a bucketed series" (not smoothed over history) is vulnerable to this class of bug whenever the newest bucket can be partially formed. When adding new timeframes/dimensions to Ψ-EMA, prefer a rolling lag on the finest-grained available series (daily closes) over comparing bucket-to-bucket, unless the bucket is guaranteed fully closed.
