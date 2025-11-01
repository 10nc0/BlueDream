const { DateTime } = require('luxon');

function calculateOptimalBucketSize(messageCount, timeSpanDays) {
    if (timeSpanDays === 0) return 24;
    
    const messagesPerDay = messageCount / timeSpanDays;
    
    if (messagesPerDay < 10) {
        return 24;
    } else if (messagesPerDay < 30) {
        return 8;
    } else {
        return 6;
    }
}

function getBucketKey(timestamp, bucketHours) {
    const dt = DateTime.fromISO(timestamp, { zone: 'utc' });
    const hour = dt.hour;
    const bucketIndex = Math.floor(hour / bucketHours);
    const bucketStartHour = bucketIndex * bucketHours;
    
    return dt.startOf('day').plus({ hours: bucketStartHour }).toISO();
}

function groupMessagesByTimeBuckets(messages, bucketHours = 24) {
    const buckets = new Map();
    
    for (const msg of messages) {
        const bucketKey = getBucketKey(msg.timestamp, bucketHours);
        
        if (!buckets.has(bucketKey)) {
            buckets.set(bucketKey, []);
        }
        buckets.get(bucketKey).push(msg);
    }
    
    const sortedBuckets = Array.from(buckets.entries())
        .sort((a, b) => new Date(b[0]) - new Date(a[0]));
    
    return sortedBuckets.map(([timestamp, messages]) => ({
        timestamp,
        label: formatBucketLabel(timestamp, bucketHours),
        messages
    }));
}

function formatBucketLabel(timestamp, bucketHours) {
    const dt = DateTime.fromISO(timestamp);
    const today = DateTime.now().startOf('day');
    const yesterday = today.minus({ days: 1 });
    const messageDay = dt.startOf('day');
    
    let dayLabel;
    if (messageDay.equals(today)) {
        dayLabel = 'Today';
    } else if (messageDay.equals(yesterday)) {
        dayLabel = 'Yesterday';
    } else {
        dayLabel = dt.toFormat('MMM d, yyyy');
    }
    
    if (bucketHours === 24) {
        return dayLabel;
    }
    
    const endHour = dt.hour + bucketHours;
    const endTime = dt.plus({ hours: bucketHours }).toFormat('ha');
    const startTime = dt.toFormat('ha');
    
    if (bucketHours === 8) {
        if (dt.hour === 0) return `${dayLabel} - Night (12am-8am)`;
        if (dt.hour === 8) return `${dayLabel} - Morning (8am-4pm)`;
        if (dt.hour === 16) return `${dayLabel} - Evening (4pm-12am)`;
    } else if (bucketHours === 6) {
        if (dt.hour === 0) return `${dayLabel} - Late Night (12am-6am)`;
        if (dt.hour === 6) return `${dayLabel} - Morning (6am-12pm)`;
        if (dt.hour === 12) return `${dayLabel} - Afternoon (12pm-6pm)`;
        if (dt.hour === 18) return `${dayLabel} - Evening (6pm-12am)`;
    }
    
    return `${dayLabel} ${startTime}-${endTime}`;
}

function analyzeMessageDensity(messages) {
    if (messages.length === 0) {
        return { bucketHours: 24, messageCount: 0, timeSpanDays: 0 };
    }
    
    const timestamps = messages.map(m => new Date(m.timestamp).getTime());
    const oldest = Math.min(...timestamps);
    const newest = Math.max(...timestamps);
    const timeSpanMs = newest - oldest;
    const timeSpanDays = Math.max(1, timeSpanMs / (1000 * 60 * 60 * 24));
    
    const bucketHours = calculateOptimalBucketSize(messages.length, timeSpanDays);
    
    return {
        bucketHours,
        messageCount: messages.length,
        timeSpanDays: Math.ceil(timeSpanDays)
    };
}

module.exports = {
    calculateOptimalBucketSize,
    getBucketKey,
    groupMessagesByTimeBuckets,
    formatBucketLabel,
    analyzeMessageDensity
};
