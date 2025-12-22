#!/usr/bin/env python3
"""
Fetch stock price history using yfinance for Ψ-EMA analysis.
Returns JSON with closing prices for the specified ticker.

Usage:
  python fetch-stock-prices.py NVDA 90
  python fetch-stock-prices.py AAPL

Output:
  JSON object with { ticker, closes, dates, error? }
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


def fetch_stock_prices(ticker: str, days: int = 90) -> dict:
    """
    Fetch historical closing prices for a stock ticker.
    
    Args:
        ticker: Stock symbol (e.g., 'NVDA', 'AAPL')
        days: Number of days of history to fetch (default 90 for EMA-55 + buffer)
    
    Returns:
        dict with keys:
            - ticker: The stock symbol
            - closes: List of closing prices (oldest to newest)
            - dates: List of date strings (YYYY-MM-DD)
            - currency: Currency of the prices
            - name: Company name
            - error: Error message if failed
    """
    try:
        stock = yf.Ticker(ticker.upper())
        
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
        
        info = stock.info
        name = info.get('shortName', info.get('longName', ticker.upper()))
        currency = info.get('currency', 'USD')
        current_price = closes[-1] if closes else None
        
        return {
            "ticker": ticker.upper(),
            "name": name,
            "currency": currency,
            "currentPrice": current_price,
            "closes": closes,
            "dates": dates,
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
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 90
    
    result = fetch_stock_prices(ticker, days)
    print(json.dumps(result))
