// Agenda is a pure projection of entries. Dates remain plain local YYYY-MM-DD
// strings so the view can render them without introducing another data type.
export function buildAgenda(entries, now = new Date()) {
  const today = startOfDay(now);
  const todayKey = dateKey(today);
  const lastVisible = new Date(today);
  lastVisible.setDate(lastVisible.getDate() + 6);
  const lastVisibleKey = dateKey(lastVisible);
  const days = new Map();
  const reminders = [];
  const seenReminders = new Set();

  for (const entry of entries) {
    const created = new Date(entry.createdAt);
    const createdKey = dateKey(created);
    if (!Number.isNaN(created.getTime()) && createdKey <= todayKey) {
      if (!days.has(createdKey)) days.set(createdKey, []);
      days.get(createdKey).push(entry);
    }

    const target = nearestReminderDate(entry.text, today);
    const key = `${target}:${entry.id}`;
    if (target && target <= lastVisibleKey && !seenReminders.has(key)) {
      seenReminders.add(key);
      reminders.push({date: target, entry});
    }
  }

  if (!days.has(todayKey)) days.set(todayKey, []);
  return {
    days: [...days].toSorted(([left], [right]) => left.localeCompare(right)).map(([date, dayEntries]) => ({date, entries: dayEntries})),
    reminders: reminders.toSorted((left, right) =>
      left.date.localeCompare(right.date) ||
      left.entry.createdAt.localeCompare(right.entry.createdAt) ||
      left.entry.id.localeCompare(right.entry.id)),
  };
}

function nearestReminderDate(text, today) {
  const candidates = [];
  const pattern = /(?:^|[^\p{L}\p{N}_])@(\d{1,4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?(?![\d-])/gu;
  for (const match of String(text).matchAll(pattern)) {
    let candidate = null;
    if (match[3]) candidate = fixedDate(Number(match[1]), Number(match[2]), Number(match[3]), today);
    else if (match[2]) candidate = annualDate(Number(match[1]), Number(match[2]), today);
    else candidate = monthlyDate(Number(match[1]), today);
    if (candidate) candidates.push(candidate);
  }
  const nearest = candidates.toSorted((left, right) => left - right)[0];
  return nearest ? dateKey(nearest) : null;
}

function fixedDate(year, month, day, today) {
  const candidate = validDate(year, month, day);
  return candidate && candidate >= today ? candidate : null;
}

function annualDate(month, day, today) {
  let candidate = validDate(today.getFullYear(), month, day);
  if (!candidate) return null;
  if (candidate < today) candidate = validDate(today.getFullYear() + 1, month, day);
  return candidate;
}

function monthlyDate(day, today) {
  if (day < 1 || day > 31) return null;
  for (let offset = 0; offset < 24; offset += 1) {
    const month = today.getMonth() + offset;
    const candidate = validDate(today.getFullYear() + Math.floor(month / 12), (month % 12) + 1, day);
    if (candidate && candidate >= today) return candidate;
  }
  return null;
}

function validDate(year, month, day) {
  const value = new Date(year, month - 1, day);
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day ? value : null;
}

function startOfDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function dateKey(value) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
