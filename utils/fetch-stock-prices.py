#!/usr/bin/env python3
"""
Fetch stock price history and fundamental data using yfinance for Ψ-EMA analysis.
Returns JSON with closing prices, dates, and fundamental metrics.

Usage:
  python fetch-stock-prices.py NVDA 180
  python fetch-stock-prices.py AAPL

Output:
  JSON object with { ticker, closes, dates, fundamentals: {...}, error? }
"""

import sys
import json
from datetime import datetime, timedelta

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


def fetch_stock_data(ticker: str, days: int = 365) -> dict:
    """
    Fetch historical closing prices and fundamental data for a stock ticker.
    Returns BOTH daily and weekly timeframes for dual Ψ-EMA analysis.
    
    Args:
        ticker: Stock symbol (e.g., 'NVDA', 'AAPL')
        days: Number of days of history to fetch (default 365 for weekly EMA coverage)
    
    Returns:
        dict with keys:
            - ticker: The stock symbol
            - daily: { closes, dates, periodDays, startDate, endDate }
            - weekly: { closes, dates, periodWeeks, startDate, endDate, unavailableReason? }
            - fundamentals: Dict with P/E, dividend yield, market cap, sector, etc.
            - currency: Currency of the prices
            - name: Company name
            - currentPrice: Latest closing price
            - error: Error message if failed
    """
    try:
        stock = yf.Ticker(ticker.upper())
        
        # Fetch historical prices - DAILY
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days)
        
        hist_daily = stock.history(start=start_date.strftime('%Y-%m-%d'), 
                                   end=end_date.strftime('%Y-%m-%d'),
                                   interval='1d')
        
        if hist_daily.empty:
            return {
                "ticker": ticker.upper(),
                "error": f"No data found for {ticker.upper()}. Check if the ticker is valid."
            }
        
        closes_daily = hist_daily['Close'].tolist()
        dates_daily = [d.strftime('%Y-%m-%d') for d in hist_daily.index]
        
        # Fetch historical prices - WEEKLY
        hist_weekly = stock.history(start=start_date.strftime('%Y-%m-%d'), 
                                    end=end_date.strftime('%Y-%m-%d'),
                                    interval='1wk')
        
        closes_weekly = hist_weekly['Close'].tolist() if not hist_weekly.empty else []
        dates_weekly = [d.strftime('%Y-%m-%d') for d in hist_weekly.index] if not hist_weekly.empty else []
        
        # Check if weekly data is sufficient for EMA (need at least 13 points for fast EMA)
        weekly_unavailable_reason = None
        if len(closes_weekly) < 13:
            weekly_unavailable_reason = f"Insufficient data: only {len(closes_weekly)} weeks available (need 13+ for EMA)"
        
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
        
        # Build weekly data object
        weekly_data = {
            "closes": closes_weekly,
            "dates": dates_weekly,
            "periodWeeks": len(closes_weekly),
            "startDate": dates_weekly[0] if dates_weekly else None,
            "endDate": dates_weekly[-1] if dates_weekly else None
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
            "daily": {
                "closes": closes_daily,
                "dates": dates_daily,
                "periodDays": len(closes_daily),
                "startDate": dates_daily[0] if dates_daily else None,
                "endDate": dates_daily[-1] if dates_daily else None
            },
            "weekly": weekly_data,
            "fundamentals": fundamentals,
            "periodDays": len(closes),
            "startDate": dates[0] if dates else None,
            "endDate": dates[-1] if dates else None
        }
        
    except Exception as e:
        return {
            "ticker": ticker.upper(),
            "error": str(e)
        }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: python fetch-stock-prices.py TICKER [days]"}))
        sys.exit(1)
    
    ticker = sys.argv[1]
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 365  # Extended to 1 year for weekly coverage
    
    result = fetch_stock_data(ticker, days)
    print(json.dumps(result))
