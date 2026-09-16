const { getPool } = require('../database/db');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TARGET = 3;
const TASK_KEY_WRITE_3 = 'write_3_articles';
const KIGALI_TIME_ZONE = 'Africa/Kigali';

const WEEKDAY_LABELS = {
  0: 'Kumwe',
  1: 'Kuwa Mbere',
  2: 'Kuwa Kabiri',
  3: 'Kuwa Gatatu',
  4: 'Kuwa Kane',
  5: 'Kuwa Gatanu',
  6: 'Kuwa Gatandatu',
};

const kigaliPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: KIGALI_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const utcPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function toParts(formatter, date) {
  const out = {};
  for (const part of formatter.formatToParts(date)) {
    if (['year', 'month', 'day', 'hour', 'minute', 'second'].includes(part.type)) {
      out[part.type] = Number(part.value);
    }
  }
  return out;
}

function kigaliOffsetMs() {
  const probe = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));
  const ut = toParts(utcPartsFormatter, probe);
  const kg = toParts(kigaliPartsFormatter, probe);
  return (
    Date.UTC(kg.year, kg.month - 1, kg.day, kg.hour, kg.minute, kg.second) -
    Date.UTC(ut.year, ut.month - 1, ut.day, ut.hour, ut.minute, ut.second)
  );
}

const KIGALI_OFFSET_MS = kigaliOffsetMs();

function utcSql(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function parseUtcSql(str) {
  if (!str) return null;
  const date = new Date(String(str).replace(' ', 'T') + 'Z');
  return isNaN(date.getTime()) ? null : date;
}

function kigaliDateStr(utcDate) {
  const p = toParts(kigaliPartsFormatter, utcDate);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function kigaliWeekday(utcDate) {
  const p = toParts(kigaliPartsFormatter, utcDate);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function kigaliDayLabel(utcDate) {
  return WEEKDAY_LABELS[kigaliWeekday(utcDate)] || 'Nyacye';
}

function kigaliDateToUtcMs(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!match) return null;
  const ms = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    0,
    0,
    0
  );
  if (Number.isNaN(ms)) return null;
  return ms - KIGALI_OFFSET_MS;
}

function getBusinessDayWindowFor(refDate) {
  const input = refDate instanceof Date ? refDate : new Date(refDate);
  const parts = toParts(kigaliPartsFormatter, input);
  const startUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - KIGALI_OFFSET_MS
  );
  const endUtc = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + 1, 0, 0, 0) - KIGALI_OFFSET_MS
  );

  return {
    date: `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`,
    start: startUtc,
    end: endUtc,
  };
}

function normalizeRoleType(roleType) {
  return roleType === 'chief_editor' ? 'chief_editor' : 'employee';
}

function buildWeekFrame(startUtc, endUtc, nowUtc) {
  const days = [];
  const todayMs = nowUtc.getTime();
  for (let t = startUtc.getTime(); t < endUtc.getTime(); t += DAY_MS) {
    const dayDate = new Date(t);
    days.push({
      date: kigaliDateStr(dayDate),
      label: kigaliDayLabel(dayDate),
      weekday: kigaliWeekday(dayDate),
      isFuture: t > todayMs,
    });
  }
  return days;
}

function weekBoundsUtc(refDate) {
  const ref = refDate instanceof Date ? refDate : new Date(refDate);
  const todayStr = kigaliDateStr(ref);
  const weekday = kigaliWeekday(ref);
  const daysSinceMonday = (weekday + 6) % 7;
  const todayUtcMs = kigaliDateToUtcMs(todayStr);
  const startUtc = new Date(todayUtcMs - daysSinceMonday * DAY_MS);
  const endUtc = new Date(startUtc.getTime() + 7 * DAY_MS);
  return { startUtc, endUtc };
}

function dateRangeUtc(startStr, endStr) {
  const startMs = kigaliDateToUtcMs(startStr);
  const endMs = kigaliDateToUtcMs(endStr);
  if (startMs == null || endMs == null || endMs < startMs) return null;
  return {
    startUtc: new Date(startMs),
    endUtc: new Date(endMs + DAY_MS),
  };
}

async function countCompletedArticles(user, startUtc, endUtc) {
  const [rows] = await getPool().query(
    `
      SELECT COUNT(DISTINCT p.id) AS cnt
      FROM posts p
      WHERE (p.author_id = ? OR (p.author_id IS NULL AND p.Author = ?))
        AND p.submitted_at IS NOT NULL
        AND p.submitted_at >= ?
        AND p.submitted_at < ?
        AND p.status IN ('approved', 'pending')
    `,
    [user.id, user.full_name || user.email || '', utcSql(startUtc), utcSql(endUtc)]
  );
  return Number(rows[0] && rows[0].cnt) || 0;
}

function cycleShape(row) {
  const start = row ? parseUtcSql(row.cycle_start_str) : null;
  const end = row ? parseUtcSql(row.cycle_end_str) : null;
  const target = Number(row && row.target) || DEFAULT_TARGET;
  const completed = Number(row && row.completed) || 0;
  return {
    id: row ? row.id : null,
    target,
    completed,
    extra: Math.max(0, completed - target),
    status: row ? row.status : 'active',
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    startDay: start ? kigaliDayLabel(start) : null,
    endDay: end ? kigaliDayLabel(end) : null,
  };
}

async function ensureDailyCycle(user) {
  const roleType = normalizeRoleType(user.role_type);
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();

    const nowMs = Date.now();
    const nowUtc = new Date(nowMs);
    const { start: businessStartUtc, end: businessEndUtc } = getBusinessDayWindowFor(nowUtc);

    const [latestRows] = await conn.query(
      `
        SELECT id, status, target, completed,
          DATE_FORMAT(cycle_start, '%Y-%m-%d %H:%i:%s') AS cycle_start_str,
          DATE_FORMAT(cycle_end, '%Y-%m-%d %H:%i:%s') AS cycle_end_str
        FROM daily_task_cycles
        WHERE user_id = ? AND role_type = ?
        ORDER BY id DESC
        LIMIT 1
        FOR UPDATE
      `,
      [user.id, roleType]
    );

    const latest = latestRows[0] || null;
    const latestCycleStart = latest ? parseUtcSql(latest.cycle_start_str) : null;
    const latestCycleEnd = latest ? parseUtcSql(latest.cycle_end_str) : null;

    if (
      latest &&
      latest.status === 'active' &&
      latestCycleEnd &&
      latestCycleEnd.getTime() > nowMs &&
      latestCycleStart &&
      latestCycleStart.getTime() === businessStartUtc.getTime()
    ) {
      const completed = await countCompletedArticles(
        user,
        latestCycleStart,
        latestCycleEnd
      );

      await conn.query(
        `
          UPDATE daily_task_cycles
          SET completed = ?,
              extra = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [
          completed,
          Math.max(0, completed - (Number(latest.target) || DEFAULT_TARGET)),
          utcSql(new Date(nowMs)),
          latest.id,
        ]
      );

      await conn.commit();

      const [freshRows] = await getPool().query(
        `
          SELECT id, status, target, completed,
            DATE_FORMAT(cycle_start, '%Y-%m-%d %H:%i:%s') AS cycle_start_str,
            DATE_FORMAT(cycle_end, '%Y-%m-%d %H:%i:%s') AS cycle_end_str
          FROM daily_task_cycles
          WHERE id = ?
        `,
        [latest.id]
      );

      return freshRows[0] || latest;
    }

    await conn.query(
      `
        UPDATE daily_task_cycles
        SET status = 'closed',
            completion_rate = ROUND(completed / NULLIF(target, 0) * 100, 2),
            updated_at = ?
        WHERE user_id = ? AND role_type = ? AND status = 'active' AND cycle_end <= ?
      `,
      [utcSql(new Date(nowMs)), user.id, roleType, utcSql(new Date(nowMs))]
    );

    const completed = await countCompletedArticles(
      user,
      businessStartUtc,
      businessEndUtc
    );

    const [existingCycle] = await conn.query(
      `
        SELECT id
        FROM daily_task_cycles
        WHERE user_id = ? AND role_type = ? AND cycle_start = ?
      `,
      [user.id, roleType, utcSql(businessStartUtc)]
    );

    const currentCycleId = existingCycle[0] ? existingCycle[0].id : null;

    if (!currentCycleId) {
      const [cycleInsert] = await conn.query(
        `
          INSERT INTO daily_task_cycles
          (user_id, role_type, cycle_start, cycle_end, target, completed, extra, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `,
        [
          user.id,
          roleType,
          utcSql(businessStartUtc),
          utcSql(businessEndUtc),
          DEFAULT_TARGET,
          completed,
          Math.max(0, completed - DEFAULT_TARGET),
          utcSql(new Date(nowMs)),
        ]
      );

      const cycleId = cycleInsert.insertId;
      const [defs] = await conn.query(
        `
          SELECT task_key, title, sort_order
          FROM daily_task_definitions
          WHERE role_type = ? AND active = 1
          ORDER BY sort_order ASC
        `,
        [roleType]
      );

      for (const def of defs || []) {
        await conn.query(
          `
            INSERT INTO daily_task_items (cycle_id, task_key, title, status, sort_order)
            VALUES (?, ?, ?, 'pending', ?)
            ON DUPLICATE KEY UPDATE id = id
          `,
          [cycleId, def.task_key, def.title, def.sort_order]
        );
      }
    } else {
      await conn.query(
        `
          UPDATE daily_task_cycles
          SET completed = ?,
              extra = ?,
              status = 'active',
              updated_at = ?
          WHERE id = ?
        `,
        [
          completed,
          Math.max(0, completed - DEFAULT_TARGET),
          utcSql(new Date(nowMs)),
          currentCycleId,
        ]
      );
    }

    await conn.commit();

    const [activeRows] = await getPool().query(
      `
        SELECT id, status, target, completed,
          DATE_FORMAT(cycle_start, '%Y-%m-%d %H:%i:%s') AS cycle_start_str,
          DATE_FORMAT(cycle_end, '%Y-%m-%d %H:%i:%s') AS cycle_end_str
        FROM daily_task_cycles
        WHERE user_id = ? AND role_type = ? AND status = 'active'
        ORDER BY id DESC
        LIMIT 1
      `,
      [user.id, roleType]
    );

    return activeRows[0] || latest;
  } catch (error) {
    try {
      await conn.rollback();
    } catch (rollbackError) {
      console.error('[daily-tasks] Rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    conn.release();
  }
}

async function getDailyTaskState(user) {
  const roleType = normalizeRoleType(user.role_type);
  const cycle = await ensureDailyCycle(user);
  const target = Number(cycle.target) || DEFAULT_TARGET;
  const completed = Number(cycle.completed) || 0;
  const cycleId = cycle.id;

  const [itemRows] = await getPool().query(
    `
      SELECT id, task_key, title, status, sort_order
      FROM daily_task_items
      WHERE cycle_id = ?
      ORDER BY sort_order ASC, id ASC
    `,
    [cycleId]
  );

  const itemsStatus = completed >= target ? 'completed' : 'pending';

  const tasks = (itemRows || []).map((item) => ({
    key: item.task_key,
    title: item.title,
    status: item.task_key === TASK_KEY_WRITE_3 ? itemsStatus : item.status,
    sortOrder: item.sort_order,
  }));

  if (tasks.length === 0) {
    const [defs] = await getPool().query(
      `
        SELECT task_key, title, sort_order
        FROM daily_task_definitions
        WHERE role_type = ? AND active = 1
        ORDER BY sort_order ASC
      `,
      [roleType]
    );

    for (const def of defs || []) {
      tasks.push({
        key: def.task_key,
        title: def.title,
        status:
          def.task_key === TASK_KEY_WRITE_3 ? itemsStatus : 'pending',
        sortOrder: def.sort_order,
      });
    }
  }

  let newlyCompleted = false;

  if (cycle.status === 'active' && completed >= target) {
    const [markRows] = await getPool().query(
      `
        SELECT DATE_FORMAT(target_reached_at, '%Y-%m-%d %H:%i:%s') AS reached_str
        FROM daily_task_cycles
        WHERE id = ?
      `,
      [cycleId]
    );

    if (!markRows[0] || !markRows[0].reached_str) {
      newlyCompleted = true;

      const nowStr = utcSql(new Date());

      await getPool().query(
        `
          UPDATE daily_task_cycles
          SET target_reached = 1,
              target_reached_at = ?,
              updated_at = ?
          WHERE id = ? AND target_reached_at IS NULL
        `,
        [nowStr, nowStr, cycleId]
      );

      try {
        await getPool().execute(
          `
            INSERT INTO notifications (recipient_type, recipient_id, type, title, message)
            VALUES (?, ?, 'daily_target', ?, ?)
          `,
          [
            roleType,
            user.id,
            'Igikorwa cy\'umunsi cyarangijwe!',
            'Murakoze! Murangije inkuru 3 mu iki gihe cy\'umunsi.',
          ]
        );
      } catch (notificationError) {
        console.error(
          '[daily-tasks] Notification insert failed:',
          notificationError.message
        );
      }
    }
  }

  const shape = cycleShape(cycle);

  return {
    cycle: {
      ...shape,
      remaining: Math.max(0, target - completed),
    },
    tasks,
    newlyCompleted,
    serverTime: new Date().toISOString(),
  };
}

function totalsFromFrame(frame, dayMap) {
  let completed = 0;
  let reachedDays = 0;
  let missedDays = 0;

  for (const day of frame) {
    const rec = dayMap[day.date] || {};
    completed += Number(rec.completed) || 0;
    if ((Number(rec.completed) || 0) >= DEFAULT_TARGET) {
      reachedDays += 1;
    } else {
      missedDays += 1;
    }
  }

  const expected = DEFAULT_TARGET * frame.length;
  const extra = Math.max(0, completed - expected);
  const completionRate = expected > 0 ? Math.round((completed / expected) * 100) : 0;

  return {
    completed,
    expected,
    extra,
    completionRate,
    reachedDays,
    missedDays,
  };
}

async function getMyWeeklyPerformance(user) {
  const roleType = normalizeRoleType(user.role_type);
  const nowUtc = new Date();
  const { startUtc, endUtc } = weekBoundsUtc(nowUtc);

  const [cycleRows] = await getPool().query(
    `
      SELECT user_id, completed, target,
        DATE_FORMAT(cycle_start, '%Y-%m-%d %H:%i:%s') AS cycle_start_str,
        DATE_FORMAT(cycle_end, '%Y-%m-%d %H:%i:%s') AS cycle_end_str
      FROM daily_task_cycles
      WHERE user_id = ? AND role_type = ?
        AND cycle_start >= ?
        AND cycle_start < ?
    `,
    [user.id, roleType, utcSql(startUtc), utcSql(endUtc)]
  );

  const frame = buildWeekFrame(startUtc, endUtc, nowUtc);
  const dayMap = {};

  for (const day of frame) {
    dayMap[day.date] = { ...day, completed: 0, target: DEFAULT_TARGET, reached: false };
  }

  for (const cycle of cycleRows || []) {
    const start = parseUtcSql(cycle.cycle_start_str);
    if (!start) continue;
    const day = kigaliDateStr(start);
    if (!dayMap[day]) continue;
    dayMap[day].completed += Number(cycle.completed) || 0;
    dayMap[day].reached =
      (Number(dayMap[day].completed) || 0) >= DEFAULT_TARGET;
  }

  const elapsed = frame.filter((day) => !day.isFuture);
  const totals = totalsFromFrame(elapsed, dayMap);

  const sorted = elapsed
    .slice()
    .sort((a, b) => (dayMap[b.date].completed || 0) - (dayMap[a.date].completed || 0));

  return {
    range: {
      start: kigaliDateStr(startUtc),
      end: kigaliDateStr(new Date(endUtc.getTime() - 1)),
      today: kigaliDateStr(nowUtc),
    },
    totals,
    days: frame.map((day) => dayMap[day.date]),
    bestDay: sorted[0]
      ? { date: sorted[0].date, completed: dayMap[sorted[0].date].completed }
      : null,
    lowestDay: sorted.length
      ? {
        date: sorted[sorted.length - 1].date,
        completed: dayMap[sorted[sorted.length - 1].date].completed,
      }
      : null,
  };
}

async function getAdminWeeklyReport({ role = 'all', start = null, end = null }) {
  const nowUtc = new Date();
  const kigaliToday = kigaliDateStr(nowUtc);

  let startUtc;
  let endUtc;
  let explicitRange = false;

  const rangeHint = dateRangeUtc(start, end);

  if (rangeHint) {
    startUtc = rangeHint.startUtc;
    endUtc = rangeHint.endUtc;
    explicitRange = true;
  } else {
    const bounds = weekBoundsUtc(nowUtc);
    startUtc = bounds.startUtc;
    endUtc = bounds.endUtc;
  }

  const roleTypes =
    role === 'employee'
      ? ['employee', 'employee']
      : role === 'chief_editor'
        ? ['chief_editor', 'chief_editor']
        : ['employee', 'chief_editor'];

  const users = [];

  if (role === 'all' || role === 'employee') {
    const [employees] = await getPool().query(
      `
        SELECT id, full_name, email, status, role AS department
        FROM employees
        ORDER BY full_name ASC
      `
    );

    for (const emp of employees || []) {
      users.push({
        id: emp.id,
        name: emp.full_name,
        email: emp.email,
        status: emp.status,
        department: emp.department || null,
        roleType: 'employee',
      });
    }
  }

  if (role === 'all' || role === 'chief_editor') {
    const [chiefs] = await getPool().query(
      `
        SELECT id, full_name, email, status
        FROM chief_editors
        ORDER BY full_name ASC
      `
    );

    for (const chief of chiefs || []) {
      users.push({
        id: chief.id,
        name: chief.full_name,
        email: chief.email,
        status: chief.status,
        department: null,
        roleType: 'chief_editor',
      });
    }
  }

  const [cycleRows] = await getPool().query(
    `
      SELECT user_id, role_type, completed, target,
        DATE_FORMAT(cycle_start, '%Y-%m-%d %H:%i:%s') AS cycle_start_str
      FROM daily_task_cycles
      WHERE role_type IN (?, ?)
        AND cycle_start >= ?
        AND cycle_start < ?
    `,
    [
      roleTypes[0],
      roleTypes[1],
      utcSql(startUtc),
      utcSql(endUtc),
    ]
  );

  const frame = buildWeekFrame(startUtc, endUtc, nowUtc);
  const countedDays = frame.filter(
    (day) => !day.isFuture && (!explicitRange || day.date <= kigaliToday)
  );
  const expectedDays = countedDays.length;
  const perUserDayMap = new Map();

  for (const cycle of cycleRows || []) {
    const start = parseUtcSql(cycle.cycle_start_str);
    if (!start) continue;
    const day = kigaliDateStr(start);
    if (!frame.some((d) => d.date === day)) continue;

    const key = `${cycle.role_type}:${cycle.user_id}`;
    if (!perUserDayMap.has(key)) perUserDayMap.set(key, {});
    const map = perUserDayMap.get(key);
    map[day] = (map[day] || 0) + (Number(cycle.completed) || 0);
  }

  const dayTotals = {};
  for (const day of frame) dayTotals[day.date] = 0;
  for (const [, map] of perUserDayMap) {
    for (const [day, value] of Object.entries(map)) {
      dayTotals[day] = (dayTotals[day] || 0) + value;
    }
  }

  const report = [];
  let totalCompleted = 0;
  let rateSum = 0;
  let rateCount = 0;
  let best = null;
  let lowest = null;

  for (const user of users) {
    const key = `${user.roleType}:${user.id}`;
    const map = perUserDayMap.get(key) || {};

    const dayRows = frame.map((day) => {
      const completed = Number(map[day.date]) || 0;
      return {
        date: day.date,
        label: day.label,
        weekday: day.weekday,
        completed,
        target: DEFAULT_TARGET,
        reached: completed >= DEFAULT_TARGET,
      };
    });

    const countedRows = dayRows.filter((row) =>
      countedDays.some((day) => day.date === row.date)
    );

    let completed = 0;
    let reachedDays = 0;
    let missedDays = 0;

    for (const row of countedRows) {
      completed += row.completed;
      if (row.completed >= DEFAULT_TARGET) {
        reachedDays += 1;
      } else {
        missedDays += 1;
      }
    }

    const expected = DEFAULT_TARGET * expectedDays;
    const extra = Math.max(0, completed - expected);
    const completionRate =
      expected > 0 ? Math.round((completed / expected) * 100) : 0;

    totalCompleted += completed;

    if (expected > 0) {
      rateSum += completionRate;
      rateCount += 1;

      if (
        !best ||
        completionRate > best.completionRate ||
        (completionRate === best.completionRate && completed > best.completed)
      ) {
        best = {
          name: user.name,
          roleType: user.roleType,
          completed,
          expected,
          completionRate,
        };
      }

      if (
        !lowest ||
        completionRate < lowest.completionRate ||
        (completionRate === lowest.completionRate && completed < lowest.completed)
      ) {
        lowest = {
          name: user.name,
          roleType: user.roleType,
          completed,
          expected,
          completionRate,
        };
      }
    }

    report.push({
      userId: user.id,
      name: user.name,
      email: user.email,
      department: user.department,
      status: user.status,
      roleType: user.roleType,
      totals: {
        completed,
        expected,
        extra,
        completionRate,
        reachedDays,
        missedDays,
      },
      days: dayRows,
    });
  }

  return {
    range: {
      start: kigaliDateStr(startUtc),
      end: kigaliDateStr(new Date(endUtc.getTime() - 1)),
      today: kigaliToday,
      explicitRange,
    },
    role,
    days: frame,
    dayTotals,
    report,
    summary: {
      totalCompleted,
      averageCompletionRate:
        rateCount > 0 ? Math.round(rateSum / rateCount) : 0,
      best,
      lowest,
      countedUsers: rateCount,
      activeWeek: !explicitRange,
    },
  };
}

async function getAdminDailyPerformance({ role = 'all' } = {}) {
  const nowUtc = new Date();
  const { start, end, date } = getBusinessDayWindowFor(nowUtc);
  const roleTypes = role === 'employee'
    ? ['employee']
    : role === 'chief_editor'
      ? ['chief_editor']
      : ['employee', 'chief_editor'];

  const [rows] = await getPool().query(
    `
      SELECT d.user_id, d.role_type, d.completed, d.target, d.extra,
        d.status,
        DATE_FORMAT(d.cycle_start, '%Y-%m-%d %H:%i:%s') AS cycle_start_str,
        DATE_FORMAT(d.cycle_end, '%Y-%m-%d %H:%i:%s') AS cycle_end_str
      FROM daily_task_cycles d
      WHERE d.role_type IN (?, ?)
        AND d.cycle_start >= ?
        AND d.cycle_start < ?
      ORDER BY d.role_type ASC, d.user_id ASC
    `,
    [roleTypes[0], roleTypes[1] || roleTypes[0], utcSql(start), utcSql(end)]
  );

  const userMap = new Map();
  for (const row of rows || []) {
    const key = `${row.role_type}:${row.user_id}`;
    userMap.set(key, row);
  }

  const employeeRows = await getPool().query(
    `
      SELECT id, full_name AS name, email, status
      FROM employees
      ORDER BY full_name ASC
    `
  );

  const chiefRows = await getPool().query(
    `
      SELECT id, full_name AS name, email, status
      FROM chief_editors
      ORDER BY full_name ASC
    `
  );

  const people = [];
  const employeeList = employeeRows[0] || [];
  const chiefList = chiefRows[0] || [];

  const addPeople = (list, roleType) => {
    for (const item of list) {
      if (role !== 'all' && role !== roleType) continue;
      const record = userMap.get(`${roleType}:${item.id}`) || null;
      const completed = Number(record?.completed || 0);
      const target = Number(record?.target || DEFAULT_TARGET);
      const remaining = Math.max(target - completed, 0);
      const extra = Math.max(completed - target, 0);
      const completionRate = target > 0 ? Math.round((completed / target) * 100) : 0;
      const status = completed === 0 ? 'NOT STARTED'
        : completed < target ? 'IN PROGRESS'
          : completed === target ? 'TARGET COMPLETED'
            : 'TARGET EXCEEDED';

      people.push({
        id: item.id,
        name: item.name,
        email: item.email,
        roleType,
        roleLabel: roleType === 'chief_editor' ? 'Chief Editor' : 'Employee',
        target,
        completed,
        remaining,
        extra,
        completionRate,
        status,
        timeLeftMs: Math.max(0, end.getTime() - nowUtc.getTime()),
        cycleStart: record ? record.cycle_start_str : null,
        cycleEnd: record ? record.cycle_end_str : null,
      });
    }
  };

  addPeople(employeeList, 'employee');
  addPeople(chiefList, 'chief_editor');

  people.sort((a, b) => a.name.localeCompare(b.name));

  const totalEmployees = people.filter((p) => p.roleType === 'employee').length;
  const totalChiefEditors = people.filter((p) => p.roleType === 'chief_editor').length;
  const reachedTarget = people.filter((p) => p.status === 'TARGET COMPLETED' || p.status === 'TARGET EXCEEDED').length;
  const inProgress = people.filter((p) => p.status === 'IN PROGRESS').length;
  const exceededTarget = people.filter((p) => p.status === 'TARGET EXCEEDED').length;
  const needsAttention = people.filter((p) => p.status === 'NOT STARTED').length;

  return {
    range: {
      date,
      start: kigaliDateStr(start),
      end: kigaliDateStr(new Date(end.getTime() - 1)),
      today: kigaliDateStr(nowUtc),
    },
    serverTime: nowUtc.toISOString(),
    nextMidnight: end.toISOString(),
    summary: {
      totalEmployees,
      totalChiefEditors,
      reachedTarget,
      inProgress,
      exceededTarget,
      needsAttention,
    },
    people,
  };
}

async function getAdminPerformanceSummary(options) {
  const data = await getAdminWeeklyReport(options);
  return {
    range: data.range,
    role: data.role,
    summary: data.summary,
  };
}

module.exports = {
  getBusinessDayWindowFor,
  getDailyTaskState,
  getMyWeeklyPerformance,
  getAdminDailyPerformance,
  getAdminWeeklyReport,
  getAdminPerformanceSummary,
};