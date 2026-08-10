const { google } = require("googleapis");

function getCalendar(auth) {
  return google.calendar({
    version: "v3",
    auth,
  });
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
    htmlLink: event.htmlLink || "",
  }));
}

module.exports = {
  listEvents,
};
