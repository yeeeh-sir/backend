const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const { withCache } = require('./cache');

const TIME_ZONE = 'Africa/Kigali';
const CACHE_TTL_SECONDS = 300;
const DATE_PRESETS = new Set(['today', 'last7', 'last28', 'last90']);

let analyticsClient = null;

function hasAnalyticsCredentials() {
    return Boolean(
        process.env.GA4_SERVICE_ACCOUNT_JSON ||
        (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS
    );
}

function getCredentialOptions() {
    const rawCredentials = process.env.GA4_SERVICE_ACCOUNT_JSON;
    const applicationCredentials = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();

    if (rawCredentials) {
        try {
            return { credentials: JSON.parse(rawCredentials) };
        } catch {
            const error = new Error('GA4_SERVICE_ACCOUNT_JSON is invalid JSON.');
            error.code = 'GA_CONFIG_INVALID';
            throw error;
        }
    }

    if (process.env.GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_PRIVATE_KEY) {
        if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
            const error = new Error('Google service-account credentials are incomplete.');
            error.code = 'GA_CREDENTIALS_INCOMPLETE';
            throw error;
        }
        return {
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL.trim(),
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
        };
    }

    if (applicationCredentials.startsWith('{')) {
        try {
            return { credentials: JSON.parse(applicationCredentials) };
        } catch {
            const error = new Error('GOOGLE_APPLICATION_CREDENTIALS JSON is invalid.');
            error.code = 'GA_CONFIG_INVALID';
            throw error;
        }
    }

    if (applicationCredentials) {
        return { keyFilename: applicationCredentials };
    }

    const error = new Error('Google service-account credentials are missing.');
    error.code = 'GA_CREDENTIALS_MISSING';
    throw error;
}

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
    const days = { today: 1, last7: 7, last28: 28, last90: 90 }[safePreset];
    const actualEnd = endDate;
    const startDate = addDays(actualEnd, -(days - 1));
    return { preset: safePreset, startDate, endDate: actualEnd, days };
}

function getAnalyticsClient() {
    if (analyticsClient) return analyticsClient;

    getPropertyId();

    analyticsClient = new BetaAnalyticsDataClient(getCredentialOptions());
    return analyticsClient;
}

async function runReport({ property, dateRanges, dimensions = [], metrics }) {
    const [response] = await getAnalyticsClient().runReport({
        property,
        dateRanges,
        dimensions,
        metrics: (metrics || ['activeUsers']).map((name) => ({ name })),
        ...(dimensions.some((dimension) => dimension.name === 'date')
            ? { orderBys: [{ dimension: { dimensionName: 'date' } }] }
            : {}),
    });
    return response;
}

function metricValue(row, index) {
    return Number(row?.metricValues?.[index]?.value || 0);
}

function dimensionValue(row, index) {
    return row?.dimensionValues?.[index]?.value || '';
}

async function getVisitorAnalytics({ preset = 'today' } = {}) {
    const range = resolveRange(preset);
    const property = `properties/${getPropertyId()}`;
    const cacheKey = `admin:ga4:visitors:${range.preset}:${range.startDate}:${range.endDate}`;

    return withCache(cacheKey, CACHE_TTL_SECONDS, async () => {
        const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
        const todayRange = resolveRange('today');
        const weekRange = resolveRange('last7');
        const monthRange = resolveRange('last28');
        let reports;
        try {
            reports = await Promise.all([
                runReport({
                    property,
                    dateRanges,
                    metrics: [
                        'activeUsers',
                        'totalUsers',
                        'sessions',
                        'screenPageViews',
                        'newUsers',
                        'userEngagementDuration',
                    ],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'date' }],
                    metrics: ['activeUsers', 'screenPageViews'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'country' }],
                    metrics: ['activeUsers'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'pagePathPlusQueryString' }, { name: 'pageTitle' }],
                    metrics: ['screenPageViews'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
                    metrics: ['sessions'],
                }),
                runReport({
                    property,
                    dateRanges: [{ startDate: todayRange.startDate, endDate: todayRange.endDate }],
                    metrics: ['activeUsers'],
                }),
                runReport({
                    property,
                    dateRanges: [{ startDate: weekRange.startDate, endDate: weekRange.endDate }],
                    metrics: ['activeUsers'],
                }),
                runReport({
                    property,
                    dateRanges: [{ startDate: monthRange.startDate, endDate: monthRange.endDate }],
                    metrics: ['activeUsers'],
                }),
            ]);
            console.info('[analytics] Google Analytics Data API success', {
                property,
                preset: range.preset,
            });
        } catch (error) {
            console.error('[analytics] Google Analytics Data API failure', {
                code: error.code || 'GA_API_ERROR',
                message: error.message || 'Unknown Google Analytics error',
                status: error.response?.status || error.status || undefined,
                details: error.details || undefined,
            });
            throw error;
        }

        const [aggregate, daily, countries, pages, sources, today, week, month] = reports;
        const aggregateRow = aggregate?.rows?.[0];
        const activeUsers = metricValue(aggregateRow, 0);
        const userEngagementDuration = metricValue(aggregateRow, 5);
        const reportTotal = (response) => metricValue(response?.rows?.[0], 0);
        const dailyVisitors = (daily?.rows || []).map((row) => ({
            date: dimensionValue(row, 0),
            visitors: metricValue(row, 0),
            pageViews: metricValue(row, 1),
        }));
        const usersByCountry = (countries?.rows || [])
            .map((row) => ({ country: dimensionValue(row, 0), users: metricValue(row, 0) }))
            .filter((row) => row.country)
            .sort((a, b) => b.users - a.users)
            .slice(0, 10);
        const topPages = (pages?.rows || [])
            .map((row) => ({ path: dimensionValue(row, 0), title: dimensionValue(row, 1), pageViews: metricValue(row, 0) }))
            .filter((row) => row.path)
            .sort((a, b) => b.pageViews - a.pageViews)
            .slice(0, 10);
        const trafficSources = (sources?.rows || [])
            .map((row) => ({ source: dimensionValue(row, 0), medium: dimensionValue(row, 1), sessions: metricValue(row, 0) }))
            .filter((row) => row.source || row.medium)
            .sort((a, b) => b.sessions - a.sessions)
            .slice(0, 10);

        let realtimeActiveUsers = null;
        try {
            const [realtime] = await getAnalyticsClient().runRealtimeReport({
                property,
                metrics: [{ name: 'activeUsers' }],
            });
            realtimeActiveUsers = metricValue(realtime?.rows?.[0], 0);
        } catch (error) {
            console.warn('[analytics] Realtime report unavailable:', error.code || error.message);
        }

        const totalUsers = metricValue(aggregateRow, 1);
        const sessions = metricValue(aggregateRow, 2);
        const pageViews = metricValue(aggregateRow, 3);
        const newUsers = metricValue(aggregateRow, 4);

        return {
            metric: 'activeUsers',
            metricLabel: 'GA4 active users (visitors)',
            timeZone: TIME_ZONE,
            preset: range.preset,
            startDate: range.startDate,
            endDate: range.endDate,
            activeUsers,
            totalUsers,
            sessions,
            pageViews,
            newUsers,
            averageEngagementTime: activeUsers > 0 ? userEngagementDuration / activeUsers : 0,
            totalVisitors: activeUsers,
            averageVisitorsPerDay: range.days > 0 ? Math.round((activeUsers / range.days) * 100) / 100 : 0,
            visitorsToday: reportTotal(today),
            visitorsThisWeek: reportTotal(week),
            visitorsThisMonth: reportTotal(month),
            realtimeActiveUsers,
            dailyVisitors,
            usersByCountry,
            topPages,
            trafficSources,
        };
    });
}

function parseDateParam(value) {
    const raw = String(value || '').trim();
    const today = currentKigaliDate();
    if (!raw || raw === 'today') return today;
    if (raw === 'yesterday') return addDays(today, -1);
    const daysAgoMatch = raw.match(/^(\d+)daysAgo$/i);
    if (daysAgoMatch) return addDays(today, -Number(daysAgoMatch[1]));
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return null;
}

function resolveAdminRange({ startDate, endDate } = {}) {
    const end = parseDateParam(endDate) || currentKigaliDate();
    const start = parseDateParam(startDate) || addDays(end, -6);
    return { startDate: start, endDate: end };
}

async function runRealtimeReport(property, { dimensions = [], metrics = ['activeUsers'] } = {}) {
    const [response] = await getAnalyticsClient().runRealtimeReport({
        property,
        ...(dimensions.length ? { dimensions } : {}),
        metrics: metrics.map((name) => ({ name })),
    });
    return response;
}

async function getAdminAnalytics({ startDate, endDate } = {}) {
    const range = resolveAdminRange({ startDate, endDate });
    const property = `properties/${getPropertyId()}`;
    const cacheKey = `admin:ga4:dashboard:${range.startDate}:${range.endDate}`;

    const reportData = await withCache(cacheKey, CACHE_TTL_SECONDS, async () => {
        const dateRanges = [{ startDate: range.startDate, endDate: range.endDate }];
        let reports;
        try {
            reports = await Promise.all([
                runReport({
                    property,
                    dateRanges,
                    metrics: [
                        'activeUsers',
                        'totalUsers',
                        'sessions',
                        'screenPageViews',
                        'newUsers',
                        'userEngagementDuration',
                    ],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'date' }],
                    metrics: ['activeUsers', 'screenPageViews'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'sessionSourceMedium' }],
                    metrics: ['sessions', 'activeUsers'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'country' }],
                    metrics: ['activeUsers'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'city' }],
                    metrics: ['activeUsers'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'pageTitle' }, { name: 'pagePath' }],
                    metrics: ['screenPageViews', 'activeUsers'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
                    metrics: ['sessions'],
                }),
                runReport({
                    property,
                    dateRanges,
                    dimensions: [{ name: 'firstUserSourceMedium' }],
                    metrics: ['activeUsers'],
                }),
            ]);
            console.info('[analytics] GA4 dashboard reports success', {
                property,
                startDate: range.startDate,
                endDate: range.endDate,
            });
        } catch (error) {
            console.error('[analytics] GA4 dashboard reports failure', {
                code: error.code || 'GA_API_ERROR',
                message: error.message || 'Unknown Google Analytics error',
                status: error.response?.status || error.status || undefined,
                details: error.details || undefined,
            });
            throw error;
        }

        const [aggregate, daily, sources, countries, cities, pages, channels, firstSources] = reports;
        const aggregateRow = aggregate?.rows?.[0];
        const activeUsers = metricValue(aggregateRow, 0);
        const userEngagementDuration = metricValue(aggregateRow, 5);

        return {
            overview: {
                activeUsers,
                totalUsers: metricValue(aggregateRow, 1),
                sessions: metricValue(aggregateRow, 2),
                pageViews: metricValue(aggregateRow, 3),
                newUsers: metricValue(aggregateRow, 4),
                averageEngagementTime: activeUsers > 0 ? userEngagementDuration / activeUsers : 0,
            },
            usersOverTime: (daily?.rows || []).map((row) => ({
                date: dimensionValue(row, 0),
                users: metricValue(row, 0),
                pageViews: metricValue(row, 1),
            })),
            viewsOverTime: (daily?.rows || []).map((row) => ({
                date: dimensionValue(row, 0),
                pageViews: metricValue(row, 1),
            })),
            trafficSources: (sources?.rows || [])
                .map((row) => ({
                    sourceMedium: dimensionValue(row, 0),
                    sessions: metricValue(row, 0),
                    activeUsers: metricValue(row, 1),
                }))
                .filter((row) => row.sourceMedium)
                .sort((a, b) => b.sessions - a.sessions),
            channels: (channels?.rows || [])
                .map((row) => ({ channel: dimensionValue(row, 0), sessions: metricValue(row, 0) }))
                .filter((row) => row.channel)
                .sort((a, b) => b.sessions - a.sessions),
            countries: (countries?.rows || [])
                .map((row) => ({ country: dimensionValue(row, 0), activeUsers: metricValue(row, 0) }))
                .filter((row) => row.country)
                .sort((a, b) => b.activeUsers - a.activeUsers),
            cities: (cities?.rows || [])
                .map((row) => ({ city: dimensionValue(row, 0), activeUsers: metricValue(row, 0) }))
                .filter((row) => row.city)
                .sort((a, b) => b.activeUsers - a.activeUsers),
            topPages: (pages?.rows || [])
                .map((row) => ({
                    title: dimensionValue(row, 0),
                    path: dimensionValue(row, 1),
                    pageViews: metricValue(row, 0),
                    activeUsers: metricValue(row, 1),
                }))
                .filter((row) => row.path)
                .sort((a, b) => b.pageViews - a.pageViews)
                .slice(0, 20),
            firstUserSources: (firstSources?.rows || [])
                .map((row) => ({ sourceMedium: dimensionValue(row, 0), activeUsers: metricValue(row, 0) }))
                .filter((row) => row.sourceMedium)
                .sort((a, b) => b.activeUsers - a.activeUsers),
        };
    });

    let realtime = { activeUsers: 0, byCountry: [] };
    try {
        const [active, byCountry] = await Promise.all([
            runRealtimeReport(property),
            runRealtimeReport(property, { dimensions: [{ name: 'country' }] }),
        ]);
        realtime = {
            activeUsers: metricValue(active?.rows?.[0], 0),
            byCountry: (byCountry?.rows || [])
                .map((row) => ({ country: dimensionValue(row, 0) || 'Unknown', activeUsers: metricValue(row, 0) }))
                .sort((a, b) => b.activeUsers - a.activeUsers),
        };
    } catch (error) {
        console.warn('[analytics] GA4 dashboard realtime report unavailable:', error.code || error.message);
    }

    return {
        ...reportData,
        realtime,
        timeZone: TIME_ZONE,
        startDate: range.startDate,
        endDate: range.endDate,
    };
}

module.exports = { getVisitorAnalytics, getAdminAnalytics, getPropertyId, hasAnalyticsCredentials };
