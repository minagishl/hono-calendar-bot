import { Hono, type Context } from 'hono';
import * as line from '@line/bot-sdk';

type Bindings = {
  LINE_CHANNEL_ACCESS_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  GCP_SERVICE_ACCOUNT: string;
  GOOGLE_CALENDAR_ID: string;
};

// Type definition for the necessary parts of the service account JSON
interface GoogleKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

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
    message += `\n${startStr} から ${endStr}`;
  });
  return message;
}

async function getCalendarEvents(
  c: Context<{ Bindings: Bindings }>,
  timeMin: string,
  timeMax: string
): Promise<any[]> {
  const serviceAccountRaw = c.env.GCP_SERVICE_ACCOUNT;

  if (!serviceAccountRaw) {
    throw new Error('Service account is not configured');
  }

  const googleKey: GoogleKey = JSON.parse(c.env.GCP_SERVICE_ACCOUNT);
  const calendarId = c.env.GOOGLE_CALENDAR_ID;

  if (!googleKey || !calendarId) {
    throw new Error(
      'Authentication credentials or Calendar ID is not configured'
    );
  }

  // Scopes for reading calendars
  const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
  const token = await getGoogleAuthToken(googleKey, scopes);

  if (!token) {
    throw new Error('Failed to obtain Google Auth token');
  }

  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events`
  );
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const data = (await response.json()) as { items: any[] };
  return data.items || [];
}

// Generate a JWT from the service account information and get a Google OAuth2 token
async function getGoogleAuthToken(
  googleKey: GoogleKey,
  scopes: string[]
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: googleKey.client_email,
    scope: scopes.join(' '),
    aud: googleKey.token_uri,
    exp: now + 3600,
    iat: now,
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const unsignedJWT = `${encodedHeader}.${encodedPayload}`;
  const signature = await signJWT(unsignedJWT, googleKey.private_key);
  const jwt = `${unsignedJWT}.${signature}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(
    jwt
  )}`;
  const resp = await fetch(googleKey.token_uri, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache',
    },
    body,
  });
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

function base64url(str: string): string {
  return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function str2ab(str: string): ArrayBuffer {
  const buf = new ArrayBuffer(str.length);
  const bufView = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) {
    bufView[i] = str.charCodeAt(i);
  }
  return buf;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function signJWT(unsigned: string, privateKey: string): Promise<string> {
  //  Remove unnecessary headers and footers in PEM format
  const pemHeader = '-----BEGIN PRIVATE KEY-----';
  const pemFooter = '-----END PRIVATE KEY-----';
  const cleanKey = privateKey
    .replace(/(\r\n|\n|\r)/gm, '')
    .replace(/\\n/g, '')
    .replace(pemHeader, '')
    .replace(pemFooter, '')
    .trim();
  // base64 decode
  const binaryKey = str2ab(atob(cleanKey));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    {
      name: 'RSASSA-PKCS1-V1_5',
      hash: { name: 'SHA-256' },
    },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-V1_5' },
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );
  return arrayBufferToBase64Url(signature);
}

export default app;
