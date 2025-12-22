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


def fetch_stock_data(ticker: str, days: int = 180) -> dict:
    """
    Fetch historical closing prices and fundamental data for a stock ticker.
    
    Args:
        ticker: Stock symbol (e.g., 'NVDA', 'AAPL')
        days: Number of days of history to fetch (default 180 for higher EMA fidelity)
    
    Returns:
        dict with keys:
            - ticker: The stock symbol
            - closes: List of closing prices (oldest to newest)
            - dates: List of date strings (YYYY-MM-DD)
            - fundamentals: Dict with P/E, dividend yield, market cap, sector, etc.
            - currency: Currency of the prices
            - name: Company name
            - currentPrice: Latest closing price
            - error: Error message if failed
    """
    try:
        stock = yf.Ticker(ticker.upper())
        
        # Fetch historical prices
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days)
        
        hist = stock.history(start=start_date.strftime('%Y-%m-%d'), 
                            end=end_date.strftime('%Y-%m-%d'))
        
        if hist.empty:
            return {
                "ticker": ticker.upper(),
                "error": f"No data found for {ticker.upper()}. Check if the ticker is valid."
            }
        
        closes = hist['Close'].tolist()
        dates = [d.strftime('%Y-%m-%d') for d in hist.index]
        
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
        
        return {
            "ticker": ticker.upper(),
            "name": name,
            "currency": currency,
            "currentPrice": current_price,
            "closes": closes,
            "dates": dates,
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
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 180
    
    result = fetch_stock_data(ticker, days)
    print(json.dumps(result))
