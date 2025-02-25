import { Hono, type Context } from 'hono';
import * as line from '@line/bot-sdk';
import { google } from 'googleapis';

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_CALENDAR_ID: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => {
  return c.json({ message: 'Hello, World!' });
});

app.post('/webhook', async (c) => {
  const config: line.ClientConfig = {
    channelAccessToken: c.env.LINE_CHANNEL_ACCESS_TOKEN,
  };
  const client = new line.messagingApi.MessagingApiClient(config);
  line.middleware({ channelSecret: c.env.LINE_CHANNEL_SECRET });

  const events: line.WebhookEvent[] = await c.req
    .json()
    .then((data) => data.events);

  await Promise.all(
    events.map(async (event: line.WebhookEvent) => {
      try {
        await messageEventHandler(c, client, event);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error(err);
        }
        return c.status(500);
      }
    })
  );

  return c.status(200);
});

const messageEventHandler = async (
  c: Context<{ Bindings: Bindings }>,
  client: line.messagingApi.MessagingApiClient,
  event: line.WebhookEvent
): Promise<line.MessageAPIResponseBase | undefined> => {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const replyToken = event.replyToken;
  // Get today's schedule from Google Calendar
  const statusMessage = await getCalendarStatus(c);
  const response: line.TextMessage = {
    type: 'text',
    text: statusMessage,
  };

  const replyMessageRequest: line.messagingApi.ReplyMessageRequest = {
    replyToken: replyToken,
    messages: [response],
  };

  await client.replyMessage(replyMessageRequest);
};

async function getCalendarStatus(
  c: Context<{ Bindings: Bindings }>
): Promise<string> {
  const now = new Date();
  // Get the start and end time of today
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1
  );
  const timeMin = startOfDay.toISOString();
  const timeMax = endOfDay.toISOString();

  const events = await getCalendarEvents(c, timeMin, timeMax);

  // If there is a schedule in progress, return "Currently in a meeting"
  for (const event of events) {
    // Get the start and end time of the event (obtained with dateTime or date)
    const start = new Date(event.start.dateTime || event.start.date);
    const end = new Date(event.end.dateTime || event.end.date);
    if (now >= start && now < end) {
      return '現在会議中です';
    }
  }

  // If the current time does not overlap with any meeting, return the number of meetings and the time of each meeting
  let message = `本日は会議が${events.length}件入っていて\n`;
  events.forEach((event, index) => {
    const start = new Date(event.start.dateTime || event.start.date);
    const end = new Date(event.end.dateTime || event.end.date);
    // Format the time in Japan's local time (24-hour display)
    const startStr = start.toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const endStr = end.toLocaleTimeString('ja-JP', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    message += `\n${startStr} から ${endStr}まで`;
  });
  return message;
}

async function getCalendarEvents(
  c: Context<{ Bindings: Bindings }>,
  timeMin: string,
  timeMax: string
): Promise<any[]> {
  const clientEmail = c.env.GOOGLE_CLIENT_EMAIL;
  // Restore the escaped newline characters if they are escaped
  const privateKey = c.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const calendarId = c.env.GOOGLE_CALENDAR_ID;

  if (!clientEmail || !privateKey || !calendarId) {
    throw new Error(
      'Google Calendar authentication information or calendar ID is not set in the environment variables'
    );
  }

  const auth = new google.auth.JWT(clientEmail, undefined, privateKey, [
    'https://www.googleapis.com/auth/calendar.readonly',
  ]);

  const calendar = google.calendar({ version: 'v3', auth });
  const res = await calendar.events.list({
    calendarId: calendarId,
    timeMin: timeMin,
    timeMax: timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });

  return res.data.items || [];
}

export default app;
