/**
 * PROMETHEUS BUSINESS RULES ENGINE
 * 
 * Predefined rules for common business scenarios:
 * - Tire inspection
 * - Expense verification
 * - Inventory audit
 * - Delivery confirmation
 */

const RULES = {
  repair: {
    name: 'Equipment/Asset Repair',
    name_id: 'Perbaikan Peralatan/Aset',
    thresholds: {
      max_downtime_hours: 24,
      severity_levels: ['critical', 'high', 'medium', 'low']
    },
    required_fields: ['item', 'issue'],
    optional_fields: ['severity', 'downtime_hours', 'repair_date', 'technician', 'parts_replaced']
  },
  
  expense: {
    name: 'Expense Verification',
    name_id: 'Verifikasi Pengeluaran',
    thresholds: {
      approval_threshold_usd: 500,
      approval_threshold_idr: 7500000  // ~$500 at 15k rate
    },
    required_fields: ['amount', 'vendor', 'date'],
    optional_fields: ['category', 'receipt_number', 'description']
  },
  
  inventory: {
    name: 'Inventory Audit',
    name_id: 'Audit Inventaris',
    thresholds: {
      variance_threshold_percent: 10
    },
    required_fields: ['item_id', 'count'],
    optional_fields: ['expected_count', 'location', 'condition']
  },
  
  delivery: {
    name: 'Delivery Confirmation',
    name_id: 'Konfirmasi Pengiriman',
    thresholds: {
      max_delay_hours: 24
    },
    required_fields: ['order_id', 'status'],
    optional_fields: ['recipient', 'timestamp', 'location', 'signature']
  },
  
  general: {
    name: 'General Check',
    name_id: 'Pemeriksaan Umum',
    thresholds: {},
    required_fields: [],
    optional_fields: []
  }
};

function validateExtractedData(data, ruleType) {
  const rule = RULES[ruleType];
  if (!rule) {
    return { valid: false, missing: [], message: `Unknown rule type: ${ruleType}` };
  }
  
  const missing = rule.required_fields.filter(field => {
    const value = data[field];
    return value === undefined || value === null || value === '';
  });
  
  return {
    valid: missing.length === 0,
    missing,
    message: missing.length > 0 
      ? `Missing required fields: ${missing.join(', ')}`
      : 'All required fields present'
  };
}

function applyBusinessRules(data, ruleType, language = 'en') {
  const rule = RULES[ruleType];
  if (!rule) {
    return {
      status: 'REVIEW',
      reason: language === 'id' 
        ? `Tipe aturan tidak dikenal: ${ruleType}`
        : `Unknown rule type: ${ruleType}`,
      recommended_action: language === 'id'
        ? 'Periksa manual diperlukan'
        : 'Manual review required',
      confidence: 0.7
    };
  }
  
  const validation = validateExtractedData(data, ruleType);
  if (!validation.valid) {
    return {
      status: 'REVIEW',
      reason: language === 'id'
        ? `Data tidak lengkap: ${validation.missing.join(', ')}`
        : validation.message,
      recommended_action: language === 'id'
        ? 'Minta informasi yang hilang'
        : 'Request missing information',
      needs_human_review: true,
      confidence: 0.7
    };
  }
  
  switch (ruleType) {
    case 'repair':
      return applyRepairRules(data, rule.thresholds, language);
    case 'expense':
      return applyExpenseRules(data, rule.thresholds, language);
    case 'inventory':
      return applyInventoryRules(data, rule.thresholds, language);
    case 'delivery':
      return applyDeliveryRules(data, rule.thresholds, language);
    default:
      return {
        status: 'PASS',
        reason: language === 'id' ? 'Data diekstrak berhasil' : 'Data extracted successfully',
        recommended_action: language === 'id' ? 'Tidak ada tindakan diperlukan' : 'No action required',
        confidence: 0.95
      };
  }
}

function applyRepairRules(data, thresholds, language) {
  const issues = [];
  const item = data.item || 'Unknown item';
  const issue = data.issue || 'No issue specified';
  const severity = (data.severity || 'medium').toLowerCase();
  const downtimeHours = parseFloat(data.downtime_hours) || 0;
  
  // Check if severity is valid
  if (!thresholds.severity_levels.includes(severity)) {
    issues.push(language === 'id'
      ? `Tingkat keparahan '${severity}' tidak dikenali`
      : `Unknown severity level: ${severity}`);
  }
  
  // Check downtime against threshold
  if (downtimeHours > thresholds.max_downtime_hours) {
    issues.push(language === 'id'
      ? `Waktu henti ${downtimeHours}jam melebihi maksimum ${thresholds.max_downtime_hours}jam`
      : `Downtime ${downtimeHours}h exceeds maximum ${thresholds.max_downtime_hours}h`);
  }
  
  // Check for critical severity
  if (severity === 'critical') {
    return {
      status: 'FAIL',
      reason: language === 'id'
        ? `${item}: ${issue} (Kritis)`
        : `${item}: ${issue} (Critical)`,
      recommended_action: language === 'id'
        ? 'Perbaikan segera diperlukan'
        : 'Immediate repair required',
      confidence: 0.95
    };
  }
  
  if (issues.length > 0) {
    return {
      status: 'WARNING',
      reason: issues.join('; '),
      recommended_action: language === 'id'
        ? 'Pantau dan rencanakan perbaikan'
        : 'Monitor and schedule repair',
      confidence: 0.95
    };
  }
  
  return {
    status: 'PASS',
    reason: language === 'id'
      ? `${item}: ${issue} - Dalam batas normal`
      : `${item}: ${issue} - Within normal limits`,
    recommended_action: language === 'id'
      ? 'Lanjutkan pemantauan rutin'
      : 'Continue routine monitoring',
    confidence: 0.95
  };
}

function applyExpenseRules(data, thresholds, language) {
  // Smart number parsing: handles Indonesian "Rp 1.500.000", US "$1,500.00", EU "1.500,00"
  let amountStr = (data.amount || '').toString().replace(/[^\d,.-]/g, '');
  
  const lastDot = amountStr.lastIndexOf('.');
  const lastComma = amountStr.lastIndexOf(',');
  const hasBothSeparators = lastDot !== -1 && lastComma !== -1;
  
  if (hasBothSeparators) {
    if (lastDot > lastComma) {
      // US format: 1,500.00 → 1500.00
      amountStr = amountStr.replace(/,/g, '');
    } else {
      // EU format: 1.500,00 → 1500.00
      amountStr = amountStr.replace(/\./g, '').replace(',', '.');
    }
  } else if (lastComma !== -1) {
    // Only commas: check if thousands separator (3 digits after) or decimal
    const afterComma = amountStr.slice(lastComma + 1);
    if (afterComma.length === 3 && !afterComma.includes(',')) {
      // Thousands: 1,500 → 1500
      amountStr = amountStr.replace(/,/g, '');
    } else {
      // Decimal: 1500,50 → 1500.50
      amountStr = amountStr.replace(',', '.');
    }
  } else if (lastDot !== -1) {
    // Only dots: check if thousands separator (3 digits after) or decimal (1-2 digits after)
    const afterDot = amountStr.slice(lastDot + 1);
    const dotCount = (amountStr.match(/\./g) || []).length;
    if (dotCount > 1 || afterDot.length === 3) {
      // Thousands: 1.500.000, 1.500 → strip dots (3 digits = thousands, not decimal)
      amountStr = amountStr.replace(/\./g, '');
    }
    // else: decimal like 1500.50 or 1500.5 → keep as-is (1-2 digits after dot)
  }
  
  let amount = parseFloat(amountStr);
  const currency = (data.currency || 'USD').toUpperCase();
  
  const threshold = currency === 'IDR' 
    ? thresholds.approval_threshold_idr 
    : thresholds.approval_threshold_usd;
  
  if (!amount || isNaN(amount)) {
    return {
      status: 'REVIEW',
      reason: language === 'id'
        ? 'Jumlah tidak dapat diparsing'
        : 'Amount could not be parsed',
      recommended_action: language === 'id'
        ? 'Verifikasi jumlah secara manual'
        : 'Verify amount manually',
      needs_human_review: true,
      confidence: 0.7
    };
  }
  
  if (amount > threshold) {
    return {
      status: 'WARNING',
      reason: language === 'id'
        ? `Jumlah ${currency} ${amount.toLocaleString()} melebihi batas persetujuan ${currency} ${threshold.toLocaleString()}`
        : `Amount ${currency} ${amount.toLocaleString()} exceeds approval threshold of ${currency} ${threshold.toLocaleString()}`,
      recommended_action: language === 'id'
        ? 'Memerlukan persetujuan manajer'
        : 'Requires manager approval',
      confidence: 0.95
    };
  }
  
  return {
    status: 'PASS',
    reason: language === 'id'
      ? `Pengeluaran ${currency} ${amount.toLocaleString()} dalam batas persetujuan`
      : `Expense ${currency} ${amount.toLocaleString()} within approval limits`,
    recommended_action: language === 'id'
      ? 'Dapat diproses langsung'
      : 'Can be processed directly',
    confidence: 0.95
  };
}

function applyInventoryRules(data, thresholds, language) {
  const count = parseFloat(data.count);
  const expected = parseFloat(data.expected_count);
  
  if (isNaN(count)) {
    return {
      status: 'REVIEW',
      reason: language === 'id'
        ? 'Jumlah stok tidak dapat diparsing'
        : 'Stock count could not be parsed',
      recommended_action: language === 'id'
        ? 'Verifikasi hitungan secara manual'
        : 'Verify count manually',
      needs_human_review: true,
      confidence: 0.7
    };
  }
  
  if (!isNaN(expected) && expected > 0) {
    const variance = Math.abs((count - expected) / expected) * 100;
    
    if (variance > thresholds.variance_threshold_percent) {
      return {
        status: 'FAIL',
        reason: language === 'id'
          ? `Varians ${variance.toFixed(1)}% melebihi batas ${thresholds.variance_threshold_percent}% (hitungan: ${count}, ekspektasi: ${expected})`
          : `Variance ${variance.toFixed(1)}% exceeds threshold of ${thresholds.variance_threshold_percent}% (count: ${count}, expected: ${expected})`,
        recommended_action: language === 'id'
          ? 'Investigasi perbedaan stok diperlukan'
          : 'Stock discrepancy investigation required',
        confidence: 0.95
      };
    }
  }
  
  return {
    status: 'PASS',
    reason: language === 'id'
      ? `Hitungan stok ${count} tercatat`
      : `Stock count of ${count} recorded`,
    recommended_action: language === 'id'
      ? 'Tidak ada tindakan diperlukan'
      : 'No action required',
    confidence: 0.95
  };
}

function applyDeliveryRules(data, thresholds, language) {
  const status = (data.status || '').toLowerCase();
  
  const successStatuses = ['delivered', 'received', 'completed', 'terkirim', 'diterima', 'selesai'];
  const failStatuses = ['failed', 'returned', 'cancelled', 'gagal', 'dikembalikan', 'dibatalkan'];
  
  if (successStatuses.some(s => status.includes(s))) {
    return {
      status: 'PASS',
      reason: language === 'id'
        ? `Pengiriman berhasil: ${data.status}`
        : `Delivery successful: ${data.status}`,
      recommended_action: language === 'id'
        ? 'Tutup order'
        : 'Close order',
      confidence: 0.95
    };
  }
  
  if (failStatuses.some(s => status.includes(s))) {
    return {
      status: 'FAIL',
      reason: language === 'id'
        ? `Pengiriman gagal: ${data.status}`
        : `Delivery failed: ${data.status}`,
      recommended_action: language === 'id'
        ? 'Hubungi pelanggan untuk jadwal ulang'
        : 'Contact customer to reschedule',
      confidence: 0.95
    };
  }
  
  return {
    status: 'WARNING',
    reason: language === 'id'
      ? `Status pengiriman: ${data.status || 'tidak diketahui'}`
      : `Delivery status: ${data.status || 'unknown'}`,
    recommended_action: language === 'id'
      ? 'Pantau dan tindak lanjut'
      : 'Monitor and follow up',
    confidence: 0.7
  };
}

function getRuleInfo(ruleType) {
  return RULES[ruleType] || RULES.general;
}

function listRules() {
  return Object.entries(RULES).map(([key, rule]) => ({
    type: key,
    name: rule.name,
    name_id: rule.name_id,
    required_fields: rule.required_fields
  }));
}

module.exports = {
  RULES,
  validateExtractedData,
  applyBusinessRules,
  getRuleInfo,
  listRules
};
