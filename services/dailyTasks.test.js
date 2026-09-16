const test = require('node:test');
const assert = require('node:assert/strict');
const { getBusinessDayWindowFor } = require('./dailyTasks');

function toKigaliDate(date) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Kigali',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });

    const parts = {};
    for (const part of formatter.formatToParts(date)) {
        if (['year', 'month', 'day'].includes(part.type)) {
            parts[part.type] = Number(part.value);
        }
    }

    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

test('business-day window follows Kigali calendar midnight instead of rolling 24h', () => {
    const now = new Date('2026-09-15T20:41:03Z');
    const { start, end } = getBusinessDayWindowFor(now);

    assert.equal(toKigaliDate(start), '2026-09-15');
    assert.equal(toKigaliDate(end), '2026-09-16');
    assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
});
