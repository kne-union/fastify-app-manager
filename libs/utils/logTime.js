const OFFSET_RE = /^([+-])(\d{2}):?(\d{2})$/;
const LINE_PREFIX_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?=: )/;

const formatterCache = new Map();

const getFormatter = timeZone => {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    );
  }
  return formatterCache.get(timeZone);
};

const parsedCache = new Map();

const parseTimezone = tz => {
  if (tz && typeof tz === 'object' && (tz.type === 'offset' || tz.type === 'iana')) {
    return tz;
  }
  const value = tz == null ? '' : String(tz).trim();
  if (!parsedCache.has(value)) {
    parsedCache.set(value, parseTimezoneValue(value));
  }
  return parsedCache.get(value);
};

const parseTimezoneValue = value => {
  const match = OFFSET_RE.exec(value);
  if (match) {
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    if (hours > 14 || minutes > 59) {
      throw new Error(`invalid logTimezone: ${value}`);
    }
    return { type: 'offset', offsetMinutes: (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes) };
  }
  if (!value) {
    throw new Error('invalid logTimezone: empty');
  }
  try {
    getFormatter(value);
  } catch (e) {
    throw new Error(`invalid logTimezone: ${value}`);
  }
  return { type: 'iana', name: value };
};

const getOffsetMinutes = (date, tz) => {
  const info = parseTimezone(tz);
  if (info.type === 'offset') {
    return info.offsetMinutes;
  }
  const parts = {};
  for (const { type, value } of getFormatter(info.name).formatToParts(date)) {
    parts[type] = value;
  }
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
};

const pad = (value, length = 2) => String(value).padStart(length, '0');

const formatOffset = minutes => {
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

const formatInTz = (date, tz, pattern = 'YYYY-MM-DDTHH:mm:ss') => {
  const shifted = new Date(date.getTime() + getOffsetMinutes(date, tz) * 60000);
  const tokens = {
    YYYY: pad(shifted.getUTCFullYear(), 4),
    MM: pad(shifted.getUTCMonth() + 1),
    DD: pad(shifted.getUTCDate()),
    HH: pad(shifted.getUTCHours()),
    mm: pad(shifted.getUTCMinutes()),
    ss: pad(shifted.getUTCSeconds())
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss/g, token => tokens[token]);
};

const toIsoInTz = (date, tz) => `${formatInTz(date, tz)}${formatOffset(getOffsetMinutes(date, tz))}`;

const dateKeyInTz = (date, tz) => formatInTz(date, tz, 'YYYY-MM-DD');

// PM2 `time: true` prefixes lines in the daemon's local time without an offset; assume it matches this process.
const convertLinePrefix = (line, tz) => {
  if (!tz || typeof line !== 'string') {
    return line;
  }
  const match = LINE_PREFIX_RE.exec(line);
  if (!match) {
    return line;
  }
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const date = new Date(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(date.getTime()) || getOffsetMinutes(date, tz) === -date.getTimezoneOffset()) {
    return line;
  }
  return `${formatInTz(date, tz)}${line.slice(match[0].length)}`;
};

const convertLogText = (text, tz) => {
  if (!tz || typeof text !== 'string') {
    return text;
  }
  return text
    .split('\n')
    .map(line => convertLinePrefix(line, tz))
    .join('\n');
};

module.exports = {
  parseTimezone,
  getOffsetMinutes,
  formatOffset,
  formatInTz,
  toIsoInTz,
  dateKeyInTz,
  convertLinePrefix,
  convertLogText
};
