#!/usr/bin/env python3
"""
Fetch stock price history and fundamental data using yfinance for Ψ-EMA analysis.
Returns JSON with closing prices, dates, and fundamental metrics.

Optimized fetching strategy (Dec 23, 2025):
- Daily: fetch exact 3mo (~55 trading days for EMA-55)
- Weekly: fetch exact 15mo (~55 weeks for EMA-55)
- Weekly candles already compress weekends/holidays (like blockchain blocks)
- No buffer logic needed - yfinance returns only trading days

Usage:
  python fetch-stock-prices.py NVDA
  python fetch-stock-prices.py AAPL

Output:
  JSON object with { ticker, closes, dates, fundamentals: {...}, error? }
"""

import sys
import json

try:
    import yfinance as yf
    import pandas as pd
except ImportError as e:
    print(json.dumps({"error": f"Missing dependency: {e}"}))
    sys.exit(1)


def safe_float(value):
    """Safely convert to float, return None if not possible."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def phi_interpolate(closes, dates):
    """
    Fill small gaps in price series using φ-interpolation (x = 1 + 1/x).
    Anchors to most recent historical data (never extrapolates beyond latest date).
    
    Args:
        closes: List of closing prices
        dates: List of corresponding dates (YYYY-MM-DD strings)
    
    Returns:
        tuple: (interpolated_closes, interpolated_dates, flags)
        flags: List of booleans, True = interpolated value
    """
    from datetime import datetime, timedelta
    
    PHI = 1.6180339887498949  # Golden ratio
    
    if len(closes) < 2:
        return closes, dates, [False] * len(closes)
    
    interpolated = []
    interpolated_dates = []
    flags = []
    
    for i in range(len(closes)):
        interpolated.append(closes[i])
        interpolated_dates.append(dates[i])
        flags.append(False)
        
        # Check gap to next bar (only if not last bar)
        if i < len(closes) - 1:
            date_curr = datetime.strptime(dates[i], '%Y-%m-%d')
            date_next = datetime.strptime(dates[i + 1], '%Y-%m-%d')
            gap_days = (date_next - date_curr).days
            
            # Conservative: only interpolate gaps of 2-3 days (unlikely with yfinance, but safe)
            if 2 <= gap_days <= 3:
                # φ-interpolation: new_value = value_1 + (value_2 - value_1) / φ
                mid_value = closes[i] + (closes[i + 1] - closes[i]) / PHI
                mid_date = date_curr + timedelta(days=gap_days // 2)
                
                interpolated.append(mid_value)
                interpolated_dates.append(mid_date.strftime('%Y-%m-%d') + '*')  # Mark with *
                flags.append(True)
    
    return interpolated, interpolated_dates, flags


def fetch_stock_data(ticker: str) -> dict:
    """
    Fetch historical closing prices and fundamental data for a stock ticker.
    Returns BOTH daily and weekly timeframes for dual Ψ-EMA analysis.
    
    Optimized minimal-fetch strategy (Dec 23, 2025):
    - Daily: '3mo' = ~55 trading days (covers EMA-55)
    - Weekly: '13mo' = ~55 weeks (exact for EMA-55)
    
    Fidelity grading (not hard-gating) handles data quality:
    - ≥174 bars: A grade (full crossover fidelity)
    - ≥55 bars: B/C grade (real θ, z, R values)
    - ≥13 bars: D grade (basic EMA, limited precision)
    - <13 bars: Unavailable (synthetic values not useful)
    
    Weekly candles are self-contained OHLC snapshots - no gap filling needed.
    Like blockchain logs, each candle compresses all activity in that period.
    
    Args:
        ticker: Stock symbol (e.g., 'NVDA', 'AAPL')
    
    Returns:
        dict with keys:
            - ticker: The stock symbol
            - daily: { closes, dates, barCount, startDate, endDate }
            - weekly: { closes, dates, barCount, startDate, endDate, unavailableReason? }
            - fundamentals: Dict with P/E, dividend yield, market cap, sector, etc.
            - currency: Currency of the prices
            - name: Company name
            - currentPrice: Latest closing price
            - error: Error message if failed
    """
    try:
        stock = yf.Ticker(ticker.upper())
        
        # Fetch DAILY data - exact 3mo (~55 trading days for EMA-55)
        hist_daily = stock.history(period='3mo', interval='1d')
        
        if hist_daily.empty:
            return {
                "ticker": ticker.upper(),
                "error": f"No data found for {ticker.upper()}. Check if the ticker is valid."
            }
        
        closes_daily = hist_daily['Close'].tolist()
        dates_daily = [d.strftime('%Y-%m-%d') for d in hist_daily.index]
        
        # φ-interpolate small gaps in daily data (conservative: 2-3 days only)
        closes_daily, dates_daily, daily_flags = phi_interpolate(closes_daily, dates_daily)
        
        # Fetch WEEKLY data - exact 13mo (~55 weeks for EMA-55)
        # Weekly candles = compressed OHLC, no gaps to fill
        hist_weekly = stock.history(period='13mo', interval='1wk')
        
        closes_weekly = hist_weekly['Close'].tolist() if not hist_weekly.empty else []
        dates_weekly = [d.strftime('%Y-%m-%d') for d in hist_weekly.index] if not hist_weekly.empty else []
        
        # φ-interpolate small gaps in weekly data (conservative: 2-3 weeks only)
        closes_weekly, dates_weekly, weekly_flags = phi_interpolate(closes_weekly, dates_weekly) if closes_weekly else ([], [], [])
        
        # Report weekly bar count - fidelity grading handles quality signaling
        # No hard gate: even partial data produces real θ, z, R values with lower fidelity grade
        weekly_unavailable_reason = None
        if len(closes_weekly) < 13:
            weekly_unavailable_reason = f"Stock history: only {len(closes_weekly)} weeks (need 13+ for basic EMA)"
        
        # Use daily closes for backward compatibility
        closes = closes_daily
        dates = dates_daily
        
        # Fetch fundamental data
        info = stock.info
        name = info.get('shortName', info.get('longName', ticker.upper()))
        currency = info.get('currency', 'USD')
        current_price = closes[-1] if closes else None
        
        # Extract fundamental metrics
        pe_ratio = safe_float(info.get('trailingPE'))
        forward_pe = safe_float(info.get('forwardPE'))
        dividend_yield = safe_float(info.get('dividendYield'))
        market_cap = safe_float(info.get('marketCap'))
        sector = info.get('sector')
        industry = info.get('industry')
        
        # Earnings date (may be list of dates or single date)
        earnings_dates = info.get('earningsDates', [])
        next_earnings = None
        if earnings_dates:
            if isinstance(earnings_dates, list) and len(earnings_dates) > 0:
                next_earnings = earnings_dates[0]
            elif isinstance(earnings_dates, str):
                next_earnings = earnings_dates
        
        # Book value and other metrics
        book_value = safe_float(info.get('bookValue'))
        fifty_two_week_high = safe_float(info.get('fiftyTwoWeekHigh'))
        fifty_two_week_low = safe_float(info.get('fiftyTwoWeekLow'))
        revenue_per_share = safe_float(info.get('revenuePerShare'))
        
        fundamentals = {
            "peRatio": pe_ratio,
            "forwardPE": forward_pe,
            "dividendYield": dividend_yield,
            "marketCap": market_cap,
            "sector": sector,
            "industry": industry,
            "nextEarningsDate": next_earnings,
            "bookValue": book_value,
            "fiftyTwoWeekHigh": fifty_two_week_high,
            "fiftyTwoWeekLow": fifty_two_week_low,
            "revenuePerShare": revenue_per_share
        }
        
        # Remove None values for cleaner output
        fundamentals = {k: v for k, v in fundamentals.items() if v is not None}
        
        # Build weekly data object with barCount, dates, and interpolation flags
        weekly_data = {
            "closes": closes_weekly,
            "dates": dates_weekly,
            "barCount": len([c for i, c in enumerate(closes_weekly) if not weekly_flags[i]]),  # Count only real bars
            "interpolatedCount": sum(weekly_flags),
            "startDate": dates_weekly[0].rstrip('*') if dates_weekly else None,
            "endDate": dates_weekly[-1].rstrip('*') if dates_weekly else None
        }
        if weekly_unavailable_reason:
            weekly_data["unavailableReason"] = weekly_unavailable_reason
        
        return {
            "ticker": ticker.upper(),
            "name": name,
            "currency": currency,
            "currentPrice": current_price,
            "closes": closes,  # Daily closes for backward compatibility
            "dates": dates,    # Daily dates for backward compatibility
            "startDate": dates[0].rstrip('*') if dates else None,
            "endDate": dates[-1].rstrip('*') if dates else None,
            "daily": {
                "closes": closes_daily,
                "dates": dates_daily,
                "barCount": len([c for i, c in enumerate(closes_daily) if not daily_flags[i]]),  # Count only real bars
                "interpolatedCount": sum(daily_flags),
                "startDate": dates_daily[0].rstrip('*') if dates_daily else None,
                "endDate": dates_daily[-1].rstrip('*') if dates_daily else None
            },
            "weekly": weekly_data,
            "fundamentals": fundamentals
        }
        
    except Exception as e:
        return {
            "ticker": ticker.upper(),
            "error": str(e)
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python fetch-stock-prices.py TICKER"}))
        sys.exit(1)
    
    ticker = sys.argv[1]
    result = fetch_stock_data(ticker)
    print(json.dumps(result))
