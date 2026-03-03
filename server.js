require('dotenv').config();
const express = require('express');
const { twiml } = require('twilio');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const initSqlJs = require('sql.js');
const { AssemblyAI } = require('assemblyai');
const path = require('path');
const fs = require('fs');

// ============================================
// ENVIRONMENT VARIABLES (set all in Railway)
// ============================================
// TWILIO_ACCOUNT_SID
// TWILIO_AUTH_TOKEN
// MAIN_PHONE_NUMBER
// SECONDARY_PHONE_NUMBER
// SIP_DOMAIN
// MOBILE_PHONE_NUMBER
// BREVO_API_KEY
// BREVO_SENDER_EMAIL
// ASSEMBLYAI_API_KEY
// CF_ACCOUNT_ID
// R2_ACCESS_KEY_ID
// R2_SECRET_ACCESS_KEY
// R2_BUCKET_NAME          e.g. allcapefence-calls
// DATA_DIR                defaults to /data (Railway persistent volume mount path)

// ============================================
// LOCAL DEV FALLBACKS
// ============================================
if (!process.env.MAIN_PHONE_NUMBER)      process.env.MAIN_PHONE_NUMBER      = '+15083942422';
if (!process.env.SECONDARY_PHONE_NUMBER) process.env.SECONDARY_PHONE_NUMBER = '+15083943024';
if (!process.env.SIP_DOMAIN)             process.env.SIP_DOMAIN             = 'allcapefence.sip.twilio.com';
if (!process.env.MOBILE_PHONE_NUMBER)    process.env.MOBILE_PHONE_NUMBER    = '+16174139699';

// ============================================
// APP SETUP
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ============================================
// DATABASE SETUP (sql.js — pure JS SQLite, no native build needed)
// ============================================
const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_PATH  = path.join(DATA_DIR, 'calls.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// sql.js loads asynchronously; we initialise it once and expose a
// synchronous-style wrapper so the rest of the file is unchanged.
let _db = null;

async function initDb() {
  const SQL = await initSqlJs();
  // Load existing DB file if it exists, otherwise start fresh
  const fileBuffer = fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : null;
  _db = fileBuffer ? new SQL.Database(fileBuffer) : new SQL.Database();

  _db.run(`
    CREATE TABLE IF NOT EXISTS calls (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      call_sid          TEXT UNIQUE,
      recording_sid     TEXT,
      from_number       TEXT,
      to_number         TEXT,
      direction         TEXT DEFAULT 'inbound',
      duration_seconds  INTEGER,
      r2_key            TEXT,
      transcript_raw    TEXT,
      transcript_pretty TEXT,
      recording_status  TEXT DEFAULT 'pending',
      transcript_status TEXT DEFAULT 'pending',
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS voicemails (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      call_sid         TEXT UNIQUE,
      recording_sid    TEXT,
      from_number      TEXT,
      duration_seconds INTEGER,
      r2_key           TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  persistDb(); // write initial file
  console.log('Database initialised at', DB_PATH);
}

// Write DB to disk after every mutating operation
function persistDb() {
  if (!_db) return;
  try {
    const data = _db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('DB persist error:', e.message);
  }
}

// Thin wrapper that mimics better-sqlite3's .prepare().run() / .all() / .get()
const db = {
  prepare(sql) {
    return {
      run(...params)  {
        _db.run(sql, params);
        persistDb();
      },
      all(...params)  {
        const stmt = _db.prepare(sql);
        const rows = [];
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
      get(...params) {
        const stmt = _db.prepare(sql);
        stmt.bind(params);
        const row = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        return row;
      }
    };
  },
  exec(sql) { _db.run(sql); persistDb(); }
};

// ============================================
// CLOUDFLARE R2 CLIENT
// ============================================
let r2Client = null;

function getR2Client() {
  if (r2Client) return r2Client;
  if (!process.env.CF_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.warn('R2 credentials not configured — recordings will not be stored in R2');
    return null;
  }
  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  return r2Client;
}

async function uploadToR2(key, buffer, contentType = 'audio/mpeg') {
  const client = getR2Client();
  if (!client) return null;
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
  return key;
}

async function getR2SignedUrl(key, expiresInSeconds = 3600) {
  const client = getR2Client();
  if (!client) return null;
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key
  });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

// ============================================
// ASSEMBLYAI CLIENT
// ============================================
function getAssemblyAI() {
  if (!process.env.ASSEMBLYAI_API_KEY) {
    console.warn('ASSEMBLYAI_API_KEY not set — transcription disabled');
    return null;
  }
  return new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });
}

// ============================================
// HELPER: Download Twilio Recording (with retry)
// ============================================
async function downloadTwilioRecording(recordingSid, maxAttempts = 6, delayMs = 3000) {
  const mp3Url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
  ).toString('base64');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, delayMs));
    console.log(`Download attempt ${attempt}/${maxAttempts} for ${recordingSid}`);

    const res = await fetch(mp3Url, { headers: { Authorization: authHeader } });
    const contentType = res.headers.get('content-type') || '';

    if (res.ok && contentType.includes('audio')) {
      const arrayBuffer = await res.arrayBuffer();
      console.log(`Downloaded ${recordingSid} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)`);
      return Buffer.from(arrayBuffer);
    }
    console.log(`Attempt ${attempt}: not ready (${res.status}, ${contentType})`);
  }
  throw new Error(`Failed to download recording ${recordingSid} after ${maxAttempts} attempts`);
}

// ============================================
// HELPER: Format AssemblyAI utterances
// ============================================
function formatTranscript(utterances) {
  if (!utterances || utterances.length === 0) return null;
  return utterances.map(u => {
    const label = u.speaker === 'A' ? 'Caller' : 'Staff';
    const mins  = Math.floor(u.start / 60000);
    const secs  = Math.floor((u.start % 60000) / 1000);
    const ts    = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `[${ts}] ${label}: ${u.text}`;
  }).join('\n');
}

// ============================================
// HELPER: EST timestamp string
// ============================================
function getEstTimestamp() {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
  }) + ' EST';
}

// ============================================
// HELPER: Send email via Brevo
// ============================================
async function sendBrevoEmail({ subject, textContent, htmlContent, attachments = [] }) {
  if (!process.env.BREVO_API_KEY) {
    console.warn('BREVO_API_KEY not set — email skipped');
    return { success: false, error: 'No Brevo API key' };
  }

  const payload = {
    sender: { name: 'All Cape Fence Phone System', email: process.env.BREVO_SENDER_EMAIL },
    to: [
      { email: 'bdowdall@allcapefence.com',    name: 'Brendan Dowdall'   },
      { email: 'rmastrianna@allcapefence.com',  name: 'Robert Mastrianna' },
      { email: 'pcollura@allcapefence.com',      name: 'Pete Collura'      }
    ],
    subject,
    textContent,
    htmlContent,
    attachment: attachments
  };

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (res.ok) {
    console.log(`Email sent: ${data.messageId}`);
    return { success: true, messageId: data.messageId };
  } else {
    console.error('Brevo error:', data);
    return { success: false, error: data.message };
  }
}

// ============================================
// CORE: Process a call recording
//   - Download from Twilio
//   - Upload to R2
//   - Transcribe with AssemblyAI
//   - Email team
//   - Save to DB
// ============================================
async function processRecording({ callSid, recordingSid, fromNumber, toNumber, direction, durationSeconds }) {
  console.log(`\nProcessing recording for call ${callSid}...`);

  // Insert pending row so dashboard shows it immediately
  db.prepare(`
    INSERT OR IGNORE INTO calls
      (call_sid, recording_sid, from_number, to_number, direction, duration_seconds, recording_status, transcript_status)
    VALUES (?, ?, ?, ?, ?, ?, 'processing', 'processing')
  `).run(callSid, recordingSid, fromNumber, toNumber, direction, durationSeconds);

  let audioBuffer    = null;
  let r2Key          = null;
  let transcriptPretty = null;
  let transcriptRaw  = null;

  // 1. Download from Twilio
  try {
    audioBuffer = await downloadTwilioRecording(recordingSid);

    // 2. Upload to R2
    r2Key = `calls/${new Date().toISOString().slice(0, 10)}/${callSid}.mp3`;
    await uploadToR2(r2Key, audioBuffer);
    console.log(`Uploaded to R2: ${r2Key}`);
    db.prepare(`UPDATE calls SET r2_key = ?, recording_status = 'stored' WHERE call_sid = ?`).run(r2Key, callSid);
  } catch (err) {
    console.error('Recording download/upload failed:', err.message);
    db.prepare(`UPDATE calls SET recording_status = 'failed' WHERE call_sid = ?`).run(callSid);
  }

  // 3. Transcribe with AssemblyAI
  const aai = getAssemblyAI();
  if (aai && audioBuffer) {
    try {
      const mp3Url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordingSid}.mp3`;

      console.log('Sending to AssemblyAI...');
      const transcript = await aai.transcripts.transcribe({
        audio_url:          mp3Url,
        http_auth_username: process.env.TWILIO_ACCOUNT_SID,
        http_auth_password: process.env.TWILIO_AUTH_TOKEN,
        speaker_labels:     true,
        speakers_expected:  2,
        punctuate:          true,
        format_text:        true
      });

      transcriptRaw    = transcript.text || '';
      transcriptPretty = formatTranscript(transcript.utterances) || transcriptRaw;

      db.prepare(`
        UPDATE calls SET transcript_raw = ?, transcript_pretty = ?, transcript_status = 'complete'
        WHERE call_sid = ?
      `).run(transcriptRaw, transcriptPretty, callSid);

      console.log('Transcription complete');
    } catch (err) {
      console.error('Transcription failed:', err.message);
      db.prepare(`UPDATE calls SET transcript_status = 'failed' WHERE call_sid = ?`).run(callSid);
    }
  }

  // 4. Send email notification
  const timestamp      = getEstTimestamp();
  const phoneNumber    = (fromNumber || '').replace(/[^0-9]/g, '');
  const filename       = `call-${phoneNumber}-${(callSid || '').slice(-8)}.mp3`;
  const audioBase64    = audioBuffer ? audioBuffer.toString('base64') : null;
  const dirLabel       = direction === 'inbound' ? 'Inbound' : 'Outbound';
  const dashboardUrl   = 'https://twilio-business-phone-production.up.railway.app/calls';

  const transcriptHtml = transcriptPretty
    ? `<div style="background:#f0f9ff;padding:15px;border-radius:6px;margin:20px 0;border-left:4px solid #2563eb;">
         <h3 style="margin-top:0;color:#1e40af;">Call Transcript</h3>
         <pre style="white-space:pre-wrap;font-family:Arial,sans-serif;font-size:13px;color:#334155;">${transcriptPretty}</pre>
       </div>`
    : `<p style="color:#666;font-style:italic;">Transcript unavailable.</p>`;

  const htmlContent = `
    <div style="font-family:Arial,sans-serif;padding:20px;background:#f5f5f5;">
      <div style="background:white;padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,.1);">
        <h2 style="color:#1e3a5f;margin-top:0;">${dirLabel} Call Recording</h2>
        <p><strong>From:</strong> ${fromNumber}</p>
        <p><strong>Duration:</strong> ${durationSeconds}s</p>
        <p><strong>Time:</strong> ${timestamp}</p>
        <p style="font-size:12px;color:#64748b;">
          Audio attached as ${filename}. View dashboard: <a href="${dashboardUrl}">${dashboardUrl}</a>
        </p>
        ${transcriptHtml}
        <p style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:10px;margin-top:20px;">
          Automated notification — All Cape Fence Phone System
        </p>
      </div>
    </div>`;

  const textContent = `${dirLabel} Call\nFrom: ${fromNumber}\nDuration: ${durationSeconds}s\nTime: ${timestamp}\n\n${transcriptPretty || 'No transcript available.'}`;

  await sendBrevoEmail({
    subject: `${dirLabel} Call from ${fromNumber} (${durationSeconds}s)`,
    textContent,
    htmlContent,
    attachments: audioBase64 ? [{ content: audioBase64, name: filename }] : []
  });
}

// ============================================
// HELPER: Process voicemail (no transcription)
// ============================================
async function sendVoicemailEmail(recordingData) {
  console.log('Processing voicemail...');
  const recordingSid = recordingData.RecordingSid;

  let audioBuffer = null;
  try {
    audioBuffer = await downloadTwilioRecording(recordingSid);
  } catch (err) {
    console.error('Voicemail download failed:', err.message);
    return { success: false, error: err.message };
  }

  const r2Key = `voicemails/${new Date().toISOString().slice(0, 10)}/${recordingData.CallSid || recordingSid}.mp3`;
  await uploadToR2(r2Key, audioBuffer);

  try {
    db.prepare(`
      INSERT OR IGNORE INTO voicemails (call_sid, recording_sid, from_number, duration_seconds, r2_key)
      VALUES (?, ?, ?, ?, ?)
    `).run(recordingData.CallSid || recordingSid, recordingSid, recordingData.From,
           parseInt(recordingData.RecordingDuration, 10) || 0, r2Key);
  } catch (err) {
    console.warn('DB voicemail insert:', err.message);
  }

  const timestamp   = getEstTimestamp();
  const phoneNumber = (recordingData.From || '').replace(/[^0-9]/g, '');
  const filename    = `voicemail-${phoneNumber}-${Date.now()}.mp3`;
  const audioBase64 = audioBuffer.toString('base64');

  return sendBrevoEmail({
    subject: `New Voicemail from ${recordingData.From}`,
    textContent: `Voicemail received\nFrom: ${recordingData.From}\nDuration: ${recordingData.RecordingDuration}s\n${timestamp}`,
    htmlContent: `
      <div style="font-family:Arial,sans-serif;padding:20px;background:#f5f5f5;">
        <div style="background:white;padding:20px;border-radius:8px;">
          <h2 style="color:#1e3a5f;margin-top:0;">New Voicemail</h2>
          <p><strong>From:</strong> ${recordingData.From}</p>
          <p><strong>Duration:</strong> ${recordingData.RecordingDuration}s</p>
          <p><strong>Received:</strong> ${timestamp}</p>
          <p style="font-size:12px;color:#64748b;">Audio attached as ${filename}</p>
        </div>
      </div>`,
    attachments: [{ content: audioBase64, name: filename }]
  });
}

// ============================================
// BUSINESS HOURS CHECK
// ============================================
function isBusinessHours() {
  const now = new Date();
  const est = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = est.getHours();
  const d = est.getDay();
  return (d >= 1 && d <= 5) && (h >= 8 && h < 17);
}

// ============================================
// BASIC ROUTES
// ============================================
app.get('/', (req, res) => res.send('All Cape Fence Phone System running'));
app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));

// ============================================
// TWILIO VOICE WEBHOOKS
// ============================================

// Incoming calls
app.post('/webhook/voice', (req, res) => {
  console.log(`Incoming call from ${req.body.From}`);
  const response = new twiml.VoiceResponse();

  if (isBusinessHours()) {
    response.say('Thank you for calling All Cape Fence. This call may be recorded for quality and training purposes. Please hold while we connect you.');

    const dial = response.dial({
      action: '/webhook/dial-status',
      method: 'POST',
      timeout: 20,
      callerId: req.body.From,
      record: 'record-from-answer-dual',
      recordingStatusCallback: '/webhook/call-recording',
      recordingStatusCallbackMethod: 'POST'
    });

    dial.sip('sip:phone1@allcapefence.sip.twilio.com');
    dial.sip('sip:phone2@allcapefence.sip.twilio.com');
    dial.sip('sip:phone3@allcapefence.sip.twilio.com');
  } else {
    response.say('Thank you for calling All Cape Fence. Our office hours are Monday through Friday, 8 AM to 5 PM. Please leave a message after the beep.');
    response.record({
      action: '/webhook/recording',
      method: 'POST',
      maxLength: 120,
      finishOnKey: '#',
      recordingStatusCallback: '/webhook/recording-status'
    });
    response.say('We did not receive a recording. Goodbye.');
  }

  res.type('text/xml');
  res.send(response.toString());
});

// Desk phones no-answer → try mobile
app.post('/webhook/dial-status', (req, res) => {
  console.log('Dial status:', req.body.DialCallStatus);
  const response = new twiml.VoiceResponse();
  const noAnswer = ['no-answer', 'busy', 'failed'].includes(req.body.DialCallStatus);

  if (noAnswer) {
    response.say('Please continue to hold while we try to reach a team member.');
    const mobileDial = response.dial({
      action: '/webhook/mobile-dial-status',
      method: 'POST',
      timeout: 15,
      callerId: req.body.To,
      record: 'record-from-answer-dual',
      recordingStatusCallback: '/webhook/call-recording',
      recordingStatusCallbackMethod: 'POST'
    });
    mobileDial.number(process.env.MOBILE_PHONE_NUMBER);
  } else {
    response.hangup();
  }

  res.type('text/xml');
  res.send(response.toString());
});

// Mobile no-answer → voicemail
app.post('/webhook/mobile-dial-status', (req, res) => {
  console.log('Mobile dial status:', req.body.DialCallStatus);
  const response = new twiml.VoiceResponse();
  const noAnswer = ['no-answer', 'busy', 'failed'].includes(req.body.DialCallStatus);

  if (noAnswer) {
    response.say('We are currently with other customers. Please leave a message after the beep.');
    response.record({
      action: '/webhook/recording',
      method: 'POST',
      maxLength: 120,
      finishOnKey: '#',
      recordingStatusCallback: '/webhook/recording-status'
    });
    response.say('We did not receive a recording. Goodbye.');
  } else {
    response.hangup();
  }

  res.type('text/xml');
  res.send(response.toString());
});

// Outbound calls from desk phone
app.post('/webhook/outbound', (req, res) => {
  console.log(`Outbound call from ${req.body.From} to ${req.body.To}`);
  const response = new twiml.VoiceResponse();

  let dest = req.body.To;
  if (dest.startsWith('sip:')) dest = dest.split('@')[0].replace('sip:', '');
  if (!dest.startsWith('+')) {
    if (dest.match(/^\d{10}$/))      dest = '+1' + dest;
    else if (dest.match(/^1\d{10}$/)) dest = '+' + dest;
    else {
      response.say('The number you dialed is not valid.');
      response.hangup();
      res.type('text/xml');
      return res.send(response.toString());
    }
  }

  // Outbound calls are NOT recorded — no disclosure needed
  const dial = response.dial({
    callerId: process.env.MAIN_PHONE_NUMBER,
    timeout: 30
  });
  dial.number(dest);

  res.type('text/xml');
  res.send(response.toString());
});

// === NEW: Call recording webhook (answered calls, both inbound + outbound) ===
app.post('/webhook/call-recording', async (req, res) => {
  res.sendStatus(200); // Acknowledge Twilio immediately

  const { RecordingSid, CallSid, RecordingDuration, RecordingStatus } = req.body;

  if (RecordingStatus !== 'completed') {
    console.log(`Recording ${RecordingSid} not completed yet: ${RecordingStatus}`);
    return;
  }

  // Fetch call metadata from Twilio
  let fromNumber = req.body.From || 'Unknown';
  let toNumber   = req.body.To   || process.env.MAIN_PHONE_NUMBER;
  let direction  = 'inbound';

  try {
    const twilioClient = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const call = await twilioClient.calls(CallSid).fetch();
    fromNumber = call.from;
    toNumber   = call.to;
    direction  = call.direction.startsWith('inbound') ? 'inbound' : 'outbound';
  } catch (err) {
    console.warn('Could not fetch Twilio call details:', err.message);
  }

  // Run async — do not await (Twilio already got its 200)
  processRecording({
    callSid: CallSid,
    recordingSid: RecordingSid,
    fromNumber,
    toNumber,
    direction,
    durationSeconds: parseInt(RecordingDuration, 10) || 0
  }).catch(err => console.error('processRecording error:', err.message));
});

// Voicemail recording (unanswered calls)
app.post('/webhook/recording', async (req, res) => {
  console.log('Voicemail webhook triggered');
  const emailResult = await sendVoicemailEmail(req.body);
  console.log(emailResult.success ? 'Voicemail email sent' : 'Voicemail email failed:' + emailResult.error);

  const response = new twiml.VoiceResponse();
  response.say('Thank you for your message. We will get back to you soon. Goodbye.');
  res.type('text/xml');
  res.send(response.toString());
});

app.post('/webhook/recording-status', (req, res) => {
  console.log('Recording status update:', req.body.RecordingStatus);
  res.sendStatus(200);
});

// ============================================
// DASHBOARD HELPERS
// ============================================
function dashboardShell(activeTab, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ACF Phone System</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f1f5f9;color:#1e293b;min-height:100vh}
    header{background:#1e3a5f;color:white;padding:14px 24px;display:flex;align-items:center;gap:12px}
    header h1{font-size:1.1rem;font-weight:700}
    header span{font-size:0.8rem;opacity:.65}
    nav{background:#0f2644;display:flex;padding:0 20px;gap:2px}
    nav a{padding:10px 16px;color:#94a3b8;text-decoration:none;font-size:.8rem;font-weight:500;border-bottom:3px solid transparent;transition:.15s}
    nav a:hover{color:#fff}
    nav a.on{color:#fff;border-bottom-color:#3b82f6}
    main{max-width:1280px;margin:0 auto;padding:24px 20px}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:22px}
    .stat{background:white;border-radius:8px;padding:18px 20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
    .stat-val{font-size:1.8rem;font-weight:700;color:#1e3a5f}
    .stat-lbl{font-size:.75rem;color:#64748b;margin-top:3px}
    .card{background:white;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden;margin-bottom:20px}
    .card-hd{padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between}
    .card-hd h2{font-size:.95rem;font-weight:600}
    .filters{padding:12px 18px;border-bottom:1px solid #e2e8f0;display:flex;gap:8px;flex-wrap:wrap}
    .filters input,.filters select{padding:7px 11px;border:1px solid #cbd5e1;border-radius:6px;font-size:.83rem;background:white}
    .filters input{flex:1;min-width:180px}
    .filters button{padding:7px 16px;background:#1e3a5f;color:white;border:none;border-radius:6px;cursor:pointer;font-size:.83rem}
    .filters a{padding:7px 12px;color:#64748b;text-decoration:none;font-size:.83rem}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:9px 14px;font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#64748b;background:#f8fafc;border-bottom:1px solid #e2e8f0;white-space:nowrap}
    td{padding:11px 14px;border-bottom:1px solid #f1f5f9;font-size:.83rem;vertical-align:top}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#fafbfc}
    .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:.68rem;font-weight:600;white-space:nowrap}
    .bg{background:#dcfce7;color:#15803d}
    .bb{background:#dbeafe;color:#1d4ed8}
    .by{background:#fef9c3;color:#854d0e}
    .br{background:#fee2e2;color:#b91c1c}
    .bk{background:#f1f5f9;color:#475569}
    audio{width:220px;height:32px;display:block;margin-top:4px}
    details summary{cursor:pointer;color:#3b82f6;font-size:.78rem;user-select:none}
    .tx{max-height:180px;overflow-y:auto;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:9px 11px;font-size:.75rem;line-height:1.65;white-space:pre-wrap;font-family:monospace;margin-top:6px}
    .empty{text-align:center;color:#94a3b8;padding:48px;font-size:.9rem}
    .mono{font-family:monospace}
  </style>
</head>
<body>
  <header>
    <div>
      <h1>All Cape Fence &mdash; Phone System</h1>
      <span>Call Recordings &amp; Voicemail Dashboard</span>
    </div>
  </header>
  <nav>
    <a href="/calls"      class="${activeTab==='calls'?'on':''}">&#128222; Call Recordings</a>
    <a href="/voicemails" class="${activeTab==='vmail'?'on':''}">&#128236; Voicemails</a>
    <a href="/test-hours" class="${activeTab==='hours'?'on':''}">&#128336; Business Hours</a>
    <a href="/debug-env"  class="${activeTab==='debug'?'on':''}">&#128295; Debug</a>
    <a href="/diagnose"   class="${activeTab==='diag'?'on':''}">&#128269; Diagnose</a>
  </nav>
  <main>${body}</main>
</body>
</html>`;
}

function badge(status) {
  const m = {
    complete:   ['bg','&#10003; Complete'],
    stored:     ['bb','&#9729; Stored'],
    processing: ['by','&#8987; Processing'],
    pending:    ['by','&#8987; Pending'],
    failed:     ['br','&#10007; Failed'],
    inbound:    ['bb','&#8601; Inbound'],
    outbound:   ['bk','&#8599; Outbound'],
  };
  const [cls, lbl] = m[status] || ['bk', status || '&mdash;'];
  return `<span class="badge ${cls}">${lbl}</span>`;
}

// ============================================
// CALLS DASHBOARD
// ============================================
app.get('/calls', async (req, res) => {
  const { search, direction } = req.query;

  let sql = 'SELECT * FROM calls';
  const params = [];
  const where = [];

  if (search) {
    where.push('(transcript_raw LIKE ? OR from_number LIKE ? OR to_number LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (direction && direction !== 'all') {
    where.push('direction = ?');
    params.push(direction);
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT 100';

  const calls = db.prepare(sql).all(...params);

  const stats = db.prepare(`
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN direction='inbound'  THEN 1 ELSE 0 END) inbound,
      SUM(CASE WHEN direction='outbound' THEN 1 ELSE 0 END) outbound,
      SUM(CASE WHEN transcript_status='complete' THEN 1 ELSE 0 END) transcribed,
      SUM(CASE WHEN DATE(created_at)=DATE('now') THEN 1 ELSE 0 END) today
    FROM calls
  `).get();

  const rows = await Promise.all(calls.map(async call => {
    let audioUrl = null;
    if (call.r2_key) {
      try { audioUrl = await getR2SignedUrl(call.r2_key, 7200); } catch(e) {}
    }

    const dt = new Date(call.created_at).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    const audio = audioUrl
      ? `<audio controls preload="none"><source src="${audioUrl}" type="audio/mpeg"></audio>`
      : `<span style="color:#94a3b8;font-size:.75rem">Not stored</span>`;

    const tx = call.transcript_pretty
      ? `<details><summary>View transcript</summary><div class="tx">${call.transcript_pretty.replace(/</g,'&lt;')}</div></details>`
      : badge(call.transcript_status);

    return `<tr>
      <td>${dt}</td>
      <td class="mono" style="font-size:.78rem">${call.from_number || '&mdash;'}</td>
      <td>${badge(call.direction)}</td>
      <td>${call.duration_seconds ? call.duration_seconds+'s' : '&mdash;'}</td>
      <td>${audio}</td>
      <td style="min-width:200px">${tx}</td>
      <td>${badge(call.recording_status)}</td>
    </tr>`;
  }));

  const body = `
    <div class="stats">
      <div class="stat"><div class="stat-val">${stats.today}</div><div class="stat-lbl">Calls Today</div></div>
      <div class="stat"><div class="stat-val">${stats.total}</div><div class="stat-lbl">Total Recorded</div></div>
      <div class="stat"><div class="stat-val">${stats.inbound}</div><div class="stat-lbl">Inbound</div></div>
      <div class="stat"><div class="stat-val">${stats.outbound}</div><div class="stat-lbl">Outbound</div></div>
      <div class="stat"><div class="stat-val">${stats.transcribed}</div><div class="stat-lbl">Transcribed</div></div>
    </div>

    <div class="card">
      <div class="card-hd"><h2>&#128222; Call Recordings (last 100)</h2></div>
      <form method="GET" action="/calls">
        <div class="filters">
          <input type="text" name="search" placeholder="Search phone number or transcript…" value="${search||''}">
          <select name="direction">
            <option value="all" ${!direction||direction==='all'?'selected':''}>All directions</option>
            <option value="inbound"  ${direction==='inbound' ?'selected':''}>Inbound</option>
            <option value="outbound" ${direction==='outbound'?'selected':''}>Outbound</option>
          </select>
          <button type="submit">Search</button>
          ${search||direction?`<a href="/calls">Clear</a>`:''}
        </div>
      </form>
      ${rows.length === 0
        ? `<div class="empty">No call recordings found.</div>`
        : `<div style="overflow-x:auto"><table>
            <thead><tr>
              <th>Date/Time (EST)</th><th>From</th><th>Direction</th><th>Duration</th>
              <th>Recording</th><th>Transcript</th><th>Status</th>
            </tr></thead>
            <tbody>${rows.join('')}</tbody>
           </table></div>`
      }
    </div>`;

  res.send(dashboardShell('calls', body));
});

// ============================================
// VOICEMAILS DASHBOARD
// ============================================
app.get('/voicemails', async (req, res) => {
  const voicemails = db.prepare('SELECT * FROM voicemails ORDER BY created_at DESC LIMIT 50').all();

  const rows = await Promise.all(voicemails.map(async vm => {
    let audioUrl = null;
    if (vm.r2_key) {
      try { audioUrl = await getR2SignedUrl(vm.r2_key, 7200); } catch(e) {}
    }

    const dt = new Date(vm.created_at).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });

    const audio = audioUrl
      ? `<audio controls preload="none"><source src="${audioUrl}" type="audio/mpeg"></audio>`
      : `<span style="color:#94a3b8;font-size:.75rem">Not stored</span>`;

    return `<tr>
      <td>${dt}</td>
      <td class="mono" style="font-size:.78rem">${vm.from_number||'&mdash;'}</td>
      <td>${vm.duration_seconds?vm.duration_seconds+'s':'&mdash;'}</td>
      <td>${audio}</td>
    </tr>`;
  }));

  const total = db.prepare('SELECT COUNT(*) n FROM voicemails').get().n;
  const today = db.prepare("SELECT COUNT(*) n FROM voicemails WHERE DATE(created_at)=DATE('now')").get().n;

  const body = `
    <div class="stats">
      <div class="stat"><div class="stat-val">${today}</div><div class="stat-lbl">Voicemails Today</div></div>
      <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">Total Voicemails</div></div>
    </div>
    <div class="card">
      <div class="card-hd"><h2>&#128236; Voicemails (last 50)</h2></div>
      ${rows.length===0
        ? `<div class="empty">No voicemails found.</div>`
        : `<div style="overflow-x:auto"><table>
            <thead><tr><th>Date/Time (EST)</th><th>From</th><th>Duration</th><th>Playback</th></tr></thead>
            <tbody>${rows.join('')}</tbody>
           </table></div>`
      }
    </div>`;

  res.send(dashboardShell('vmail', body));
});

// ============================================
// UTILITY & DEBUG ROUTES
// ============================================

app.get('/test-hours', (req, res) => {
  const est = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const data = {
    currentEstTime: est.toLocaleString(),
    hour: est.getHours(),
    day: est.getDay(),
    dayName: dayNames[est.getDay()],
    isBusinessHours: isBusinessHours(),
    mobileNumber: process.env.MOBILE_PHONE_NUMBER || 'Not set'
  };
  res.send(dashboardShell('hours', `<div class="card" style="padding:24px"><pre style="font-size:.9rem">${JSON.stringify(data,null,2)}</pre></div>`));
});

app.get('/debug-env', (req, res) => {
  const data = {
    twilio:     { hasSid: !!process.env.TWILIO_ACCOUNT_SID, hasToken: !!process.env.TWILIO_AUTH_TOKEN },
    phones:     { main: process.env.MAIN_PHONE_NUMBER, secondary: process.env.SECONDARY_PHONE_NUMBER, mobile: process.env.MOBILE_PHONE_NUMBER },
    brevo:      { hasKey: !!process.env.BREVO_API_KEY, sender: process.env.BREVO_SENDER_EMAIL },
    assemblyai: { hasKey: !!process.env.ASSEMBLYAI_API_KEY },
    r2:         { hasAccount: !!process.env.CF_ACCOUNT_ID, hasAccess: !!process.env.R2_ACCESS_KEY_ID, hasSecret: !!process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET_NAME },
    db:         { calls: db.prepare('SELECT COUNT(*) n FROM calls').get().n, voicemails: db.prepare('SELECT COUNT(*) n FROM voicemails').get().n }
  };
  res.send(dashboardShell('debug', `<div class="card" style="padding:24px"><pre style="font-size:.85rem">${JSON.stringify(data,null,2)}</pre></div>`));
});

app.get('/test-email', async (req, res) => {
  const result = await sendBrevoEmail({
    subject: 'Test Email — All Cape Fence Phone System',
    textContent: 'Test email from phone system.',
    htmlContent: '<h2 style="color:green">Test Email OK</h2><p>Brevo integration is working.</p>'
  });
  res.json(result);
});

app.get('/diagnose', async (req, res) => {
  const results = {
    brevo: { configured: !!process.env.BREVO_API_KEY && !!process.env.BREVO_SENDER_EMAIL }
  };

  // AssemblyAI ping
  if (process.env.ASSEMBLYAI_API_KEY) {
    try {
      const r = await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
        headers: { authorization: process.env.ASSEMBLYAI_API_KEY }
      });
      results.assemblyai = { configured: true, status: r.status, ok: r.status !== 401 };
    } catch (e) {
      results.assemblyai = { configured: true, ok: false, error: e.message };
    }
  } else {
    results.assemblyai = { configured: false };
  }

  // R2 write test
  const r2 = getR2Client();
  if (r2) {
    try {
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: 'test/ping.txt',
        Body: Buffer.from('ping'),
        ContentType: 'text/plain'
      }));
      results.r2 = { configured: true, writable: true };
    } catch (e) {
      results.r2 = { configured: true, writable: false, error: e.message };
    }
  } else {
    results.r2 = { configured: false };
  }

  results.db = {
    calls: db.prepare('SELECT COUNT(*) n FROM calls').get().n,
    voicemails: db.prepare('SELECT COUNT(*) n FROM voicemails').get().n
  };

  res.send(dashboardShell('diag', `<div class="card" style="padding:24px"><pre style="font-size:.85rem">${JSON.stringify(results,null,2)}</pre></div>`));
});

// ============================================
// START (DB must init before accepting requests)
// ============================================
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`\nAll Cape Fence Phone System on port ${PORT}`);
    console.log(`Webhook:    https://twilio-business-phone-production.up.railway.app/webhook/voice`);
    console.log(`Dashboard:  https://twilio-business-phone-production.up.railway.app/calls`);
    console.log(`Voicemails: https://twilio-business-phone-production.up.railway.app/voicemails`);
    console.log(`R2 bucket:  ${process.env.R2_BUCKET_NAME || 'NOT CONFIGURED'}`);
    console.log(`AssemblyAI: ${process.env.ASSEMBLYAI_API_KEY ? 'configured' : 'NOT CONFIGURED'}\n`);
  });
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});