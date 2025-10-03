import { google } from 'googleapis';

function decodeServiceAccount() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!b64) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_B64 missing');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  return JSON.parse(json);
}

function getAuth() {
  const key = decodeServiceAccount();
  const scopes = ['https://www.googleapis.com/auth/calendar'];
  return new google.auth.JWT(key.client_email, undefined, key.private_key, scopes);
}

export async function listFreeSlots({ days = 14, tz, slotMinutes = 30, workStart = '09:00', workEnd='18:00' }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calId = process.env.CALENDAR_ID;
  const now = new Date();
  const end = new Date(now.getTime() + days*24*60*60*1000);

  const slots = [];
  for (let d = new Date(now); d <= end; d = new Date(d.getTime() + 24*60*60*1000)) {
    const day = new Date(d);
    const [sh, sm] = workStart.split(':').map(Number);
    const [eh, em] = workEnd.split(':').map(Number);
    for (let t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm);
         t < new Date(day.getFullYear(), day.getMonth(), day.getDate(), eh, em);
         t = new Date(t.getTime() + slotMinutes*60*1000)) {
      if (t < now) continue;
      slots.push(new Date(t));
    }
  }

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      timeZone: tz,
      items: [{ id: calId }]
    }
  });
  const busy = fb.data.calendars[calId]?.busy || [];
  const busyRanges = busy.map(b => [new Date(b.start), new Date(b.end)]);

  function isBusy(dt) {
    const dt2 = new Date(dt.getTime() + slotMinutes*60*1000);
    return busyRanges.some(([s,e]) => dt < e && dt2 > s);
  }

  const free = slots.filter(s => !isBusy(s));
  return free.slice(0, 6).map(d => ({
    iso: d.toISOString(),
    label: d.toLocaleString('es-MX', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })
  }));
}

export async function createTentativeEvent({ startISO, minutes = 30, summary, description }) {
  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  const calId = process.env.CALENDAR_ID;
  const start = new Date(startISO);
  const end = new Date(start.getTime() + minutes*60*1000);
  const tz = process.env.CALENDAR_TIMEZONE || 'America/Mexico_City';

  const ev = await calendar.events.insert({
    calendarId: calId,
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
      status: 'tentative'
    }
  });
  return ev.data;
}
