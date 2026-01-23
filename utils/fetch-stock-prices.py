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


# ============================================================================
# ATOMIC UNIT OF PRODUCTION INFERENCE
# Maps sector/industry to likely atomic units (what the company produces/sells)
# Used for Robinhood-style stock summary headers
# ============================================================================

# ============================================================================
# ATOMIC UNIT GLOSSARY (State vs Flow distinction)
# 
# The Universal Pattern:
#   State = stock (balance sheet analogue — accumulated quanta at time t)
#   Flow = income statement analogue (rate of change — issuance/payment/dividend)
#
# Guard = Flow sufficient to renew state without breach
#         Extraction % not exceeding renewal capacity
#
# 0 + φ⁰ + φ¹ = φ²
# ============================================================================

# Sector-level atomic units with guard checks
SECTOR_ATOMIC_UNITS = {
    # Fintech - Lending: loan book (state) vs issuance/payment (flow)
    # Guard: NPL ratio = extraction breach indicator
    'Financial Services': ['loan book (state)', 'issuance (flow)', 'payments (flow)', 'AUM (state)', 'TPV (flow)'],
    
    # Commerce: inventory/GMV (state) vs orders/shipments (flow)
    # Guard: inventory turnover = flow/stock (low = dead stock silt)
    'Consumer Cyclical': ['inventory (state)', 'orders (flow)', 'shipments (flow)', 'GMV booked (state)', 'tickets (flow)'],
    'Consumer Defensive': ['inventory (state)', 'orders (flow)', 'baskets (flow)', 'GMV booked (state)', 'tickets (flow)'],
    
    # Service: backlog/ARR (state) vs contracts/projects (flow)
    # Guard: burn multiple = cash flow vs backlog (guard for runway)
    'Technology': ['ARR/MRR (state)', 'subscriptions (state)', 'new contracts (flow)', 'API calls (flow)', 'users (state)'],
    
    # Commodity: reserves/stockpile (state) vs extraction/shipments (flow)
    # Guard: depletion rate vs discovery rate = renewal guard
    'Basic Materials': ['reserves (state)', 'stockpile (state)', 'extraction (flow)', 'shipments (flow)', 'production (flow)'],
    'Energy': ['reserves (state)', 'capacity MW (state)', 'barrels (flow)', 'MWh (flow)', 'production (flow)'],
    
    # Real Estate: portfolio value (state) vs acquisitions/rental (flow)
    # Guard: cap rate = NOI / property value (extraction yield)
    'Real Estate': ['portfolio value (state)', 'units (state)', 'acquisitions (flow)', 'rental income (flow)', 'NOI (flow)'],
    
    # Manufacturing: inventory + WIP (state) vs production/shipments (flow)
    # Guard: inventory days = stock / daily flow (high = silt)
    'Industrials': ['inventory (state)', 'WIP (state)', 'production (flow)', 'shipments (flow)', 'backlog (state)'],
    
    # Telecom: subscriber base (state) vs ARPU × new subs − churn (flow)
    # Guard: churn rate = flow out / average stock
    'Communication Services': ['subscribers (state)', 'ARPU × subs (flow)', 'churn (flow)', 'net adds (flow)', 'MAU (state)'],
    
    # Healthcare: patient panel/bed capacity (state) vs visits/procedures (flow)
    # Guard: occupancy rate = flow / capacity
    'Healthcare': ['patient panel (state)', 'bed capacity (state)', 'visits (flow)', 'procedures (flow)', 'admissions (flow)'],
    
    # Utilities: installed capacity (state) vs generation/sales (flow)
    # Guard: capacity factor = actual output / max possible
    'Utilities': ['capacity MW (state)', 'customers (state)', 'MWh generated (flow)', 'sales (flow)', 'connections (state)'],
}

# Industry-specific atomic units with guard checks
INDUSTRY_ATOMIC_UNITS = {
    # ========== FINTECH ==========
    # Lending: loan book (state) vs issuance/payment (flow)
    # Guard: NPL ratio = extraction breach indicator
    'Banks—Diversified': ['loan book (state)', 'deposits (state)', 'issuance (flow)', 'payments (flow)', 'NPL ratio (guard)'],
    'Banks—Regional': ['loan book (state)', 'deposits (state)', 'issuance (flow)', 'payments (flow)', 'NPL ratio (guard)'],
    'Credit Services': ['loan book (state)', 'credit lines (state)', 'issuance (flow)', 'payments (flow)', 'NPL ratio (guard)'],
    'Mortgage Finance': ['loan book (state)', 'properties (state)', 'originations (flow)', 'payments (flow)', 'delinquency (guard)'],
    
    # Payments: wallet balance (state) vs TPV + active users (flow)
    # Guard: velocity = TPV / average balance (too high = silt risk)
    'Financial Data & Stock Exchanges': ['wallet avg (state)', 'deposits (state)', 'TPV (flow)', 'active users (flow)', 'velocity (guard)'],
    'Capital Markets': ['AUM (state)', 'deposits (state)', 'trades (flow)', 'commissions (flow)', 'velocity (guard)'],
    
    # AUM: current AUM (state) vs inflows/outflows (flow)
    # Guard: fee on AUM >1.5-2% = long-term unsustainable
    'Asset Management': ['AUM (state)', 'funds (state)', 'inflows (flow)', 'outflows (flow)', 'fee % (guard)'],
    'Insurance—Life': ['AUM (state)', 'policies (state)', 'premiums (flow)', 'claims (flow)', 'loss ratio (guard)'],
    'Insurance—Property & Casualty': ['reserves (state)', 'policies (state)', 'premiums (flow)', 'claims (flow)', 'combined ratio (guard)'],
    
    # ========== COMMERCE ==========
    # Inventory/GMV (state) vs orders/shipments/tickets (flow)
    # Guard: inventory turnover = flow/stock (low = dead stock silt)
    'Internet Retail': ['inventory (state)', 'GMV booked (state)', 'orders (flow)', 'shipments (flow)', 'turnover (guard)'],
    'Specialty Retail': ['inventory (state)', 'SKUs (state)', 'transactions (flow)', 'tickets (flow)', 'turnover (guard)'],
    'Restaurants': ['locations (state)', 'inventory (state)', 'orders (flow)', 'covers (flow)', 'turnover (guard)'],
    'Discount Stores': ['inventory (state)', 'SKUs (state)', 'baskets (flow)', 'transactions (flow)', 'turnover (guard)'],
    'Grocery Stores': ['inventory (state)', 'SKUs (state)', 'baskets (flow)', 'deliveries (flow)', 'turnover (guard)'],
    'Apparel Retail': ['inventory (state)', 'SKUs (state)', 'orders (flow)', 'units sold (flow)', 'turnover (guard)'],
    'Home Improvement Retail': ['inventory (state)', 'SKUs (state)', 'transactions (flow)', 'projects (flow)', 'turnover (guard)'],
    'Auto Manufacturers': ['backlog (state)', 'inventory (state)', 'vehicles delivered (flow)', 'orders (flow)', 'days inventory (guard)'],
    
    # ========== SERVICE (SaaS/Consulting) ==========
    # Backlog/ARR (state) vs new contracts/projects (flow)
    # Guard: burn multiple = cash flow vs backlog
    'Software—Infrastructure': ['ARR (state)', 'seats (state)', 'new contracts (flow)', 'API calls (flow)', 'burn multiple (guard)'],
    'Software—Application': ['ARR (state)', 'subscriptions (state)', 'new contracts (flow)', 'users (flow)', 'burn multiple (guard)'],
    'Consulting Services': ['backlog (state)', 'contracts (state)', 'engagements (flow)', 'billable hours (flow)', 'utilization (guard)'],
    'Staffing & Employment Services': ['contracts (state)', 'candidates (state)', 'placements (flow)', 'billable hours (flow)', 'fill rate (guard)'],
    'Information Technology Services': ['backlog (state)', 'SLAs (state)', 'projects (flow)', 'tickets resolved (flow)', 'utilization (guard)'],
    
    # ========== TECHNOLOGY ==========
    'Semiconductors': ['fab capacity (state)', 'design wins (state)', 'chip units (flow)', 'wafers (flow)', 'utilization (guard)'],
    'Consumer Electronics': ['inventory (state)', 'SKUs (state)', 'devices sold (flow)', 'units (flow)', 'turnover (guard)'],
    'Internet Content & Information': ['MAU (state)', 'content items (state)', 'page views (flow)', 'ad impressions (flow)', 'engagement (guard)'],
    
    # ========== MEDIA/SUBSCRIPTION ==========
    # Active subscribers (state) vs net adds (flow)
    # Guard: LTV / CAC = lifetime flow / acquisition cost
    'Entertainment': ['subscribers (state)', 'titles (state)', 'net adds (flow)', 'hours streamed (flow)', 'LTV/CAC (guard)'],
    'Telecom Services': ['subscribers (state)', 'connections (state)', 'ARPU × subs (flow)', 'churn (flow)', 'churn rate (guard)'],
    
    # ========== GAMING ==========
    # DAU/MAU (state) vs installs − uninstalls (flow)
    # Guard: retention cohort flow vs stock
    'Electronic Gaming & Multimedia': ['DAU/MAU (state)', 'players (state)', 'installs (flow)', 'in-app purchases (flow)', 'retention (guard)'],
    
    # ========== HEALTHCARE ==========
    # Patient panel/bed capacity (state) vs visits/procedures (flow)
    # Guard: occupancy rate = flow / capacity
    'Drug Manufacturers—General': ['patients (state)', 'trials (state)', 'doses (flow)', 'prescriptions (flow)', 'trial success (guard)'],
    'Biotechnology': ['patients (state)', 'indications (state)', 'doses (flow)', 'approvals (flow)', 'trial success (guard)'],
    'Medical Devices': ['installed base (state)', 'contracts (state)', 'procedures (flow)', 'units sold (flow)', 'utilization (guard)'],
    'Healthcare Plans': ['members (state)', 'enrollees (state)', 'claims (flow)', 'visits (flow)', 'MLR (guard)'],
    
    # ========== COMMODITY ==========
    # Proven reserves/stockpile (state) vs production/shipments (flow)
    # Guard: depletion rate vs discovery rate = renewal guard
    'Oil & Gas Integrated': ['reserves (state)', 'wells (state)', 'barrels (flow)', 'MMBtu (flow)', 'reserve replacement (guard)'],
    'Oil & Gas E&P': ['reserves (state)', 'leases (state)', 'barrels (flow)', 'wells drilled (flow)', 'reserve replacement (guard)'],
    'Oil & Gas Refining & Marketing': ['capacity (state)', 'retail sites (state)', 'gallons (flow)', 'shipments (flow)', 'utilization (guard)'],
    'Steel': ['capacity (state)', 'inventory (state)', 'tons shipped (flow)', 'orders (flow)', 'utilization (guard)'],
    'Aluminum': ['capacity (state)', 'inventory (state)', 'tons shipped (flow)', 'orders (flow)', 'utilization (guard)'],
    'Copper': ['reserves (state)', 'capacity (state)', 'tons shipped (flow)', 'extraction (flow)', 'reserve replacement (guard)'],
    'Gold': ['reserves (state)', 'stockpile (state)', 'oz produced (flow)', 'extraction (flow)', 'reserve replacement (guard)'],
    'Agricultural Inputs': ['inventory (state)', 'contracts (state)', 'tons shipped (flow)', 'acres treated (flow)', 'turnover (guard)'],
    
    # ========== MANUFACTURING ==========
    # Finished goods + WIP (state) vs production/shipments (flow)
    # Guard: inventory days = stock / daily flow (high = silt)
    'Aerospace & Defense': ['backlog (state)', 'contracts (state)', 'aircraft delivered (flow)', 'systems (flow)', 'book-to-bill (guard)'],
    'Industrial Machinery': ['backlog (state)', 'inventory (state)', 'units shipped (flow)', 'orders (flow)', 'days inventory (guard)'],
    
    # ========== TRANSPORTATION ==========
    'Airlines': ['fleet (state)', 'routes (state)', 'passengers (flow)', 'seat miles (flow)', 'load factor (guard)'],
    'Railroads': ['track miles (state)', 'cars (state)', 'carloads (flow)', 'ton-miles (flow)', 'operating ratio (guard)'],
    'Trucking': ['trucks (state)', 'routes (state)', 'shipments (flow)', 'miles driven (flow)', 'utilization (guard)'],
    'Shipping & Ports': ['vessels (state)', 'routes (state)', 'TEUs (flow)', 'cargo tons (flow)', 'utilization (guard)'],
    
    # ========== ENERGY/UTILITIES ==========
    # Installed capacity (state) vs generation/sales (flow)
    # Guard: capacity factor = actual output / max possible
    'Utilities—Regulated Electric': ['capacity MW (state)', 'customers (state)', 'MWh delivered (flow)', 'sales (flow)', 'capacity factor (guard)'],
    'Utilities—Renewable': ['capacity MW (state)', 'PPAs (state)', 'MWh generated (flow)', 'installations (flow)', 'capacity factor (guard)'],
    
    # ========== REAL ESTATE ==========
    # Property portfolio (state) vs acquisitions/rental income (flow)
    # Guard: cap rate = NOI / property value (extraction yield)
    'REIT—Retail': ['sq ft (state)', 'properties (state)', 'rental income (flow)', 'leases signed (flow)', 'cap rate (guard)'],
    'REIT—Residential': ['units (state)', 'properties (state)', 'rental income (flow)', 'renewals (flow)', 'cap rate (guard)'],
    'REIT—Industrial': ['sq ft (state)', 'warehouses (state)', 'rental income (flow)', 'leases (flow)', 'cap rate (guard)'],
    'REIT—Office': ['sq ft (state)', 'buildings (state)', 'rental income (flow)', 'leases (flow)', 'cap rate (guard)'],
}


def infer_atomic_units(sector, industry):
    """
    Infer top 3-5 atomic units of production based on sector and industry.
    Industry-specific mapping takes priority over sector mapping.
    
    Args:
        sector: Company sector (e.g., 'Technology')
        industry: Company industry (e.g., 'Semiconductors')
    
    Returns:
        List of 3-5 atomic unit strings, or None if unknown
    """
    # Try industry-specific mapping first (more precise)
    if industry and industry in INDUSTRY_ATOMIC_UNITS:
        return INDUSTRY_ATOMIC_UNITS[industry][:5]
    
    # Fall back to sector mapping
    if sector and sector in SECTOR_ATOMIC_UNITS:
        return SECTOR_ATOMIC_UNITS[sector][:5]
    
    # Default for unknown
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


def fetch_stock_data(ticker: str, custom_period: str | None = None) -> dict:
    """
    Fetch historical closing prices and fundamental data for a stock ticker.
    Returns BOTH daily and weekly timeframes for dual Ψ-EMA analysis.
    
    Optimized minimal-fetch strategy (Dec 28, 2025):
    - Daily: '6mo' = ~130 trading days (covers 98-row warm-up + 30+ usable rows)
    - Weekly: '4y' = ~208 weeks (covers 98-row warm-up + high-fidelity EMA)
    
    z-score warm-up requirement (vφ⁷ 2-pass MAD):
    - Pass 1: 50-period rolling median = 49 warm-up rows
    - Pass 2: 50-period MAD of |price - median| = 49 more rows
    - Total: 98 rows before first valid z-score
    
    Fidelity grading handles data quality:
    - ≥174 bars: A grade (full crossover fidelity)
    - ≥99 bars: B grade (valid z-scores available)
    - ≥55 bars: C grade (θ available, z partial)
    - <55 bars: D grade (limited precision)
    
    Weekly candles are self-contained OHLC snapshots - no gap filling needed.
    Like blockchain logs, each candle compresses all activity in that period.
    
    Args:
        ticker: Stock symbol (e.g., 'NVDA', 'AAPL')
        custom_period: Optional custom period (e.g., '1y', '5y')
    
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
        
        # Scale periods with null guards and cushion
        # Default: 98 rows + cushion -> 6mo daily (~130 bars), 4y weekly (~208 bars)
        daily_period = custom_period if custom_period else '6mo'
        weekly_period = '4y' if not custom_period else (custom_period if 'y' in custom_period else '4y')

        # Fetch DAILY data
        hist_daily = stock.history(period=daily_period, interval='1d')
        
        if hist_daily.empty:
            return {
                "ticker": ticker.upper(),
                "error": f"No data found for {ticker.upper()}. Check if the ticker is valid."
            }
        
        closes_daily = hist_daily['Close'].tolist()
        dates_daily = [d.strftime('%Y-%m-%d') for d in hist_daily.index]
        
        # φ-interpolate small gaps in daily data (conservative: 2-3 days only)
        closes_daily, dates_daily, daily_flags = phi_interpolate(closes_daily, dates_daily)
        
        # Fetch WEEKLY data
        hist_weekly = stock.history(period=weekly_period, interval='1wk')
        
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
        debt_to_equity = safe_float(info.get('debtToEquity'))
        sector = info.get('sector')
        industry = info.get('industry')
        
        # Get business summary for Robinhood-style one-liner
        business_summary = info.get('longBusinessSummary', '')
        # Extract first sentence as one-liner (up to 150 chars)
        if business_summary:
            first_sentence = business_summary.split('.')[0].strip()
            if len(first_sentence) > 150:
                first_sentence = first_sentence[:147] + '...'
            business_summary = first_sentence
        else:
            business_summary = None
        
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
        
        # Infer atomic units of production based on sector/industry
        atomic_units = infer_atomic_units(sector, industry)
        
        fundamentals = {
            "peRatio": pe_ratio,
            "forwardPE": forward_pe,
            "dividendYield": dividend_yield,
            "marketCap": market_cap,
            "debtToEquity": debt_to_equity,
            "sector": sector,
            "industry": industry,
            "summary": business_summary,
            "atomicUnits": atomic_units,
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
        print(json.dumps({"error": "Usage: python fetch-stock-prices.py TICKER [PERIOD]"}))
        sys.exit(1)
    
    ticker = sys.argv[1]
    custom_period = sys.argv[2] if len(sys.argv) > 2 else None
    result = fetch_stock_data(ticker, custom_period)
    print(json.dumps(result))
