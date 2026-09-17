const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { withCache } = require('./cache');

const TIME_ZONE = 'Africa/Kigali';
const CACHE_TTL_SECONDS = 300;
const DATE_PRESETS = new Set(['today', 'yesterday', 'last7', 'last30', 'last90']);

let analyticsClient = null;

function getPropertyId() {
    const propertyId = String(
        process.env.GA_PROPERTY_ID || process.env.GA4_PROPERTY_ID || ''
    ).trim();

    if (!/^\d+$/.test(propertyId)) {
        const error = new Error('GA_PROPERTY_ID is not configured with a numeric GA4 property ID.');
        error.code = propertyId ? 'GA_PROPERTY_INVALID' : 'GA_PROPERTY_MISSING';
        throw error;
    }

    return propertyId;
}

function dateParts(date) {
    const values = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date).reduce((result, part) => {
        if (part.type !== 'literal') result[part.type] = part.value;
        return result;
    }, {});
    return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateString, amount) {
    const date = new Date(`${dateString}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + amount);
    return date.toISOString().slice(0, 10);
}

function currentKigaliDate() {
    return dateParts(new Date());
}

function resolveRange(preset = 'today') {
    const safePreset = DATE_PRESETS.has(preset) ? preset : 'today';
    const endDate = currentKigaliDate();
    const days = { today: 1, yesterday: 1, last7: 7, last30: 30, last90: 90 }[safePreset];
    const actualEnd = safePreset === 'yesterday' ? addDays(endDate, -1) : endDate;
    const startDate = safePreset === 'yesterday' ? actualEnd : addDays(actualEnd, -(days - 1));
    return { preset: safePreset, startDate, endDate: actualEnd, days };
}

function getAnalyticsClient() {
    if (analyticsClient) return analyticsClient;

    getPropertyId();

    const rawCredentials = process.env.GA4_SERVICE_ACCOUNT_JSON;
    const options = {};
    if (rawCredentials) {
        try {
            options.credentials = JSON.parse(rawCredentials);
        } catch {
            const error = new Error('GA4_SERVICE_ACCOUNT_JSON is invalid JSON.');
            error.code = 'GA_CONFIG_INVALID';
            throw error;
        }
    } else if (process.env.GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_PRIVATE_KEY) {
        if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            const error = new Error('Google service-account credentials are incomplete.');
            error.code = 'GA_CREDENTIALS_INCOMPLETE';
            throw error;
        }
        options.credentials = {
            client_email: process.env.GOOGLE_CLIENT_EMAIL.trim(),
            private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        };
    } else if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const error = new Error('Google service-account credentials are missing.');
        error.code = 'GA_CREDENTIALS_MISSING';
        throw error;
    }

    analyticsClient = new BetaAnalyticsDataClient(options);
    return analyticsClient;
}

async function runReport({ property, dateRanges, dimensions = [] }) {
    const [response] = await getAnalyticsClient().runReport({
        property,
        dateRanges,
        dimensions,
        metrics: [{ name: 'activeUsers' }],
        ...(dimensions.length ? { orderBys: [{ dimension: { dimensionName: 'date' } }] } : {}),
    });
    return response;
}

async function getVisitorAnalytics({ preset = 'today' } = {}) {
    const range = resolveRange(preset);
    const property = `properties/${getPropertyId()}`;
    const cacheKey = `admin:ga4:visitors:${range.preset}:${range.startDate}:${range.endDate}`;

    return withCache(cacheKey, CACHE_TTL_SECONDS, async () => {
        const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
        const weekRange = resolveRange('last7');
        const monthRange = resolveRange('last30');
        const todayRange = resolveRange('today');
        const [aggregate, daily, today, week, month] = await Promise.all([
            runReport({ property, dateRanges }),
            runReport({ property, dateRanges, dimensions: [{ name: 'date' }] }),
            runReport({ property, dateRanges: [{ startDate: todayRange.startDate, endDate: todayRange.endDate }] }),
            runReport({ property, dateRanges: [{ startDate: weekRange.startDate, endDate: weekRange.endDate }] }),
            runReport({ property, dateRanges: [{ startDate: monthRange.startDate, endDate: monthRange.endDate }] }),
        ]);

        const totalVisitors = Number(aggregate?.rows?.[0]?.metricValues?.[0]?.value || 0);
        const reportTotal = (response) => Number(response?.rows?.[0]?.metricValues?.[0]?.value || 0);
        const dailyVisitors = (daily?.rows || []).map((row) => ({
            date: row.dimensionValues?.[0]?.value || '',
            visitors: Number(row.metricValues?.[0]?.value || 0),
        }));

        return {
            metric: 'activeUsers',
            metricLabel: 'GA4 active users (visitors)',
            timeZone: TIME_ZONE,
            preset: range.preset,
            startDate: range.startDate,
            endDate: range.endDate,
            totalVisitors,
            averageVisitorsPerDay: range.days > 0 ? Math.round((totalVisitors / range.days) * 100) / 100 : 0,
            visitorsToday: reportTotal(today),
            visitorsThisWeek: reportTotal(week),
            visitorsThisMonth: reportTotal(month),
            dailyVisitors,
        };
    });
}

module.exports = { getVisitorAnalytics };
