const { google } = require("googleapis");

function getCalendar(auth) {
  return google.calendar({
    version: "v3",
    auth,
  });
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Google Calendar needs `date` for all-day events and `dateTime` for timed
// ones. Callers pass a single string, so pick the field from its shape.
function timePoint(value, timeZone) {
  if (DATE_ONLY.test(value)) {
    return { date: value };
  }

  return {
    dateTime: value,
    ...(timeZone ? { timeZone } : {}),
  };
}

async function listEvents(
  auth,
  { calendarId = "primary", timeMin, timeMax, maxResults = 20 } = {}
) {
  const calendar = getCalendar(auth);

  const response = await calendar.events.list({
    calendarId,
    timeMin: timeMin || new Date().toISOString(),
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (response.data.items || []).map((event) => ({
    id: event.id,
    status: event.status,
    summary: event.summary || "(no title)",
    description: event.description || "",
    location: event.location || "",
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    attendees: (event.attendees || []).map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName || "",
      responseStatus: attendee.responseStatus,
      organizer: !!attendee.organizer,
    })),
    colorId: event.colorId || null,
    recurrence: event.recurrence || null,
    recurringEventId: event.recurringEventId || null,
    htmlLink: event.htmlLink || "",
  }));
}

async function searchEvents(
  auth,
  { calendarId = "primary", query, timeMin, timeMax, maxResults = 20 } = {}
) {
  const calendar = getCalendar(auth);

  const response = await calendar.events.list({
    calendarId,
    q: query,
    timeMin: timeMin || new Date().toISOString(),
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  return (response.data.items || []).map((event) => ({
    id: event.id,
    status: event.status,
    summary: event.summary || "(no title)",
    description: event.description || "",
    location: event.location || "",
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    attendees: (event.attendees || []).map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName || "",
      responseStatus: attendee.responseStatus,
      organizer: !!attendee.organizer,
    })),
    colorId: event.colorId || null,
    recurrence: event.recurrence || null,
    recurringEventId: event.recurringEventId || null,
    htmlLink: event.htmlLink || "",
  }));
}

async function createEvent(
  auth,
  {
    calendarId = "primary",
    summary,
    description,
    location,
    start,
    end,
    timeZone,
    attendees,
    recurrence,
    colorId,
  }
) {
  const calendar = getCalendar(auth);

  const event = {
    summary,
    description,
    location,
    start: timePoint(start, timeZone),
    end: timePoint(end, timeZone),
    ...(recurrence?.length ? { recurrence } : {}),
    ...(colorId ? { colorId } : {}),
    ...(attendees?.length
      ? {
          attendees: attendees.map((email) => ({
            email,
          })),
        }
      : {}),
  };

  const response = await calendar.events.insert({
    calendarId,
    requestBody: event,
  });

  return {
    id: response.data.id,
    status: response.data.status,
    summary: response.data.summary || "(no title)",
    description: response.data.description || "",
    location: response.data.location || "",
    start:
      response.data.start?.dateTime ||
      response.data.start?.date ||
      null,
    end:
      response.data.end?.dateTime ||
      response.data.end?.date ||
      null,
    attendees: (response.data.attendees || []).map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName || "",
      responseStatus: attendee.responseStatus,
      organizer: !!attendee.organizer,
    })),
    colorId: response.data.colorId || null,
    recurrence: response.data.recurrence || null,
    recurringEventId: response.data.recurringEventId || null,
    htmlLink: response.data.htmlLink || "",
  };
}

async function updateEvent(
  auth,
  {
    calendarId = "primary",
    eventId,
    summary,
    description,
    location,
    start,
    end,
    timeZone,
    attendees,
    recurrence,
    colorId,
  }
) {
  const calendar = getCalendar(auth);

  const event = {};

  if (summary !== undefined) event.summary = summary;
  if (description !== undefined) event.description = description;
  if (location !== undefined) event.location = location;

  if (start !== undefined) {
    event.start = timePoint(start, timeZone);
  }

  if (end !== undefined) {
    event.end = timePoint(end, timeZone);
  }

  if (recurrence !== undefined) {
    event.recurrence = recurrence;
  }

  if (colorId !== undefined) {
    event.colorId = colorId;
  }

  if (attendees !== undefined) {
    event.attendees = attendees.map((email) => ({
      email,
    }));
  }

  const response = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: event,
  });

  return {
    id: response.data.id,
    status: response.data.status,
    summary: response.data.summary || "(no title)",
    description: response.data.description || "",
    location: response.data.location || "",
    start:
      response.data.start?.dateTime ||
      response.data.start?.date ||
      null,
    end:
      response.data.end?.dateTime ||
      response.data.end?.date ||
      null,
    attendees: (response.data.attendees || []).map((attendee) => ({
      email: attendee.email,
      displayName: attendee.displayName || "",
      responseStatus: attendee.responseStatus,
      organizer: !!attendee.organizer,
    })),
    colorId: response.data.colorId || null,
    recurrence: response.data.recurrence || null,
    recurringEventId: response.data.recurringEventId || null,
    htmlLink: response.data.htmlLink || "",
  };
}

async function deleteEvent(
  auth,
  { calendarId = "primary", eventId }
) {
  const calendar = getCalendar(auth);

  await calendar.events.delete({
    calendarId,
    eventId,
  });

  return {
    eventId,
    deleted: true,
  };
}

module.exports = {
  listEvents,
  searchEvents,
  createEvent,
  updateEvent,
  deleteEvent,
};
